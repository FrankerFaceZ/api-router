'use strict';

const debug = require('debug')('ffz-api-router');
const FindMyWay = require('find-my-way');
const pathToRegexp = require('path-to-regexp');
const METHODS = require('methods');
const formatURL = require('url').format;
const reuse = require('reusify');

const compose = require('./composer');
const Mount = require('./mount');

const has = (thing, key) => Object.prototype.hasOwnProperty.call(thing, key);
const NOOP = () => {};

const HOST_OPTS = {
	delimiter: '.',
	strict: true,
	sensitive: false
};


module.exports = Router;

/**
 * Create a new Router.
 *
 * @constructor
 * @param {Object} [opts] Options for initializing this Router and the internal find-my-way router.
 * @param {String} [opts.host] An optional host for this router. Used when generating URLs. Can include variables, though that's slower and not recommended.
 * @param {String} [opts.name] An optional name for this router. Used when resolving a route for URL generation.
 * @param {String} [opts.prefix] An optional prefix to apply to all routes for this Router.
 * @param {Object} [opts.findMyWay] Options to provide to the internal find-my-way router.
 * @param {Boolean} [opts.paramwareBeforeDataware=false] If this is true, middleware registered for specific params will run before data-based middleware.
 * @param {Boolean|Router~dataMiddleware} [opts.mountMiddleware] Middleware to use for {@link Router#mount} instead of {@link Mount}. If set to false, this will disable the automatic `mount` data-based middleware. As a result, {@link Router#mount} will not function correctly.
 * @param {Boolean|Router~handleOptions} [opts.handleOptions] Whether or not to handle OPTIONS requests. Optionally takes a function to handle OPTIONS.
 * @param {Boolean|Router~handleOptions} [opts.handle405] Whether or not to generate 405 responses when there are no matching methods for a route. Optionally takes a function to handle 405s.
 */
function Router(opts) {
	if ( !(this instanceof Router) )
		return new Router(opts);

	this.opts = opts || {};
	this.opts.paramwareBeforeDataware = this.opts.paramwareBeforeDataware || false;
	if ( this.opts.mountMiddleware === undefined )
		this.opts.mountMiddleware = Mount;

	this.opts.handle405 = this.opts.handle405 == null ? true : this.opts.handle405;
	this.opts.handleOptions = this.opts.handleOptions == null ? true : this.opts.handleOptions;

	// Routers that we interact with.
	this._parents = [];
	this._nested = {};

	// Content defined on *this* Router.
	this.routes = [];
	this.middlewares = [];

	this.paramwares = {};
	this.datawares = {};

	this.dataware_sort = {};
	this.dataware_default = {};
	this.dataware_exclusive = new Set;

	if ( this.opts.mountMiddleware ) {
		if ( typeof this.opts.mountMiddleware !== 'function' )
			throw new TypeError('opts.mountMiddleware must be a function');

		this.datawares.mount = [this.opts.mountMiddleware];
		this.dataware_sort.mount = -10;
		this.dataware_exclusive.add('mount');
	}

	// Internals
	this._routers = [];
	this._routes = new Map;
	this._named = {};
	this._middlewares = {};

	this._live = false;
}

/**
 * A Koa middleware function that has an additional parameter containing the internal
 * route data, called when a route is matched but the requested method has no handler.
 *
 * These functions are used for generating `405 Method Not Allowed` responses, as well
 * as responses to `OPTIONS` requests.
 *
 * @example
 * const router = Router({
 *     handleOptions: (ctx, next, store) => {
 *         ctx.set('Allow', Object.keys(store).join(', ').toUpperCase());
 *         ctx.status = 204;
 *     }
 * })
 *
 * @callback Router~handleOptions
 * @param {Object} ctx The Koa Context
 * @param {Function} next The next middleware in the stack
 * @param {Object} store The internal route object, with keys for each handled method
 */

/**
 * A factory for Koa middleware, acting off of data attached to a specific route.
 * The returned function or functions may have a `sort` property for overriding the
 * sorting of that specific middleware instance on that specific route.
 *
 * @example
 * router.useData('database', options => {
 *     const connection = database.getConnection(options);
 *
 *     return async (ctx, next) => {
 *         const cursor = connection.getCursor();
 *         ctx.db = cursor;
 *         try {
 *             await next();
 *         } finally {
 *             cursor.close();
 *             ctx.db = null;
 *         }
 *     }
 * });
 *
 * router.useData('validation', options => {
 *     const methods = [];
 *
 *     if ( options.query )
 *         methods.push((ctx, next) => {
 *             validateQuery(options.query, ctx.query);
 *             return next();
 *         });
 *
 *     if ( options.result ) {
 *         const fn = async (ctx, next) => {
 *             await next();
 *             validateResult(options.result, ctx);
 *         };
 *
 *         fn.sort = 2;
 *         methods.push(fn);
 *     }
 *
 *     return methods;
 * });
 *
 * @callback Router~dataMiddleware
 * @param {*} data The data attached to a route that triggered the instantiation of this
 * data-ware middleware.
 * @param {String} route The applicable route
 * @param {Object} _store The internal data store for the route.
 * @returns {Function|Function[]} Koa Middleware
 */

// Middleware

/**
 * Get a middleware method for adding a {@link Router} to Koa.
 *
 * @example
 * const router = Router();
 * app.use(router.middleware())
 *
 * @returns {Function} Koa Middleware
 */
Router.prototype.middleware = function() {
	const router = this;

	if ( ! this._live ) {
		this._live = true;
		this._update();
	}

	// Context URL Generation
	let pool;

	function URLFor() {
		this.context = null;

		const that = this;

		this.urlFor = function(name, params, options) {
			if ( name.startsWith('.') ) {
				const name_prefix = that.context.state._route.name_prefix;
				if ( name_prefix )
					name = name_prefix + name;
				else
					name = name.slice(1);
			}

			return router.urlFor(name, params, options, that.context.request.host, that.context.request.protocol);
		}

		this.done = function(stuff) {
			that.context.urlFor = null;
			that.context = null;
			pool.release(that);
			return stuff;
		}

		this.catch = function(err) {
			that.context.urlFor = null;
			that.context = null;
			pool.release(that);
			throw err;
		}
	}

	pool = reuse(URLFor);

	// The Middleware
	const dispatch = function dispatch(ctx, next) {
		debug('%s %s', ctx.method, ctx.path);
		const has_timers = ctx.startTimer;

		if ( has_timers )
			ctx.startTimer('routing');

		const method = ctx.method.toLowerCase();
		let match, host_params;

		if ( router._routers ) {
			const host = ctx.request.host ? ctx.request.host.toLowerCase() : '';
			for(const [fn, matcher, rt, plucker] of router._routers) {
				let fn_match;
				if ( fn === -1 || (fn === 0 && matcher === host) || (fn === 1 && (plucker ? (fn_match = matcher.exec(host)) : matcher.test(host))) ) {
					match = rt.find('GET', ctx.path);
					if ( match ) {
						host_params = plucker && fn_match ? plucker(fn_match) : null;
						break;
					}
				}
			}
		}

		if ( ! match ) {
			if ( has_timers )
				ctx.stopTimer('routing');
			return next();
		}

		const {params, store} = match;
		const data = store[method] || (method !== 'options' && store.all);

		ctx.request.host_params = ctx.host_params = host_params;
		ctx.request.params = ctx.params = params;
		ctx.state._route = data;
		ctx.state.route = data && data.options;

		const urls = pool.get();
		urls.context = ctx;
		ctx.urlFor = urls.urlFor;

		if ( data ) {
			if ( has_timers )
				ctx.stopTimer('routing');
			return Promise.resolve(data.fn(ctx, next)).then(urls.done).catch(urls.catch);
		}

		let fn;
		if ( method === 'options' && router.opts.handleOptions ) {
			if ( typeof router.opts.handleOptions === 'function' )
				fn = router.opts.handleOptions;
			else
				fn = handleOptions;

		} else if ( ! router.opts.handle405 ) {
			if ( has_timers )
				ctx.stopTimer('routing');

			return Promise.resolve(next()).then(urls.done).catch(urls.catch);

		} else if ( typeof router.opts.handle405 === 'function' )
			fn = router.opts.handle405;
		else
			fn = handle405;

		if ( has_timers )
			ctx.stopTimer('routing');

		return Promise.resolve(fn(ctx, next, store)).then(urls.done).catch(urls.catch)
	}

	dispatch.router = this;
	return dispatch;
}


function handle405(ctx, next, store) {
	const allowed = store.all ? METHODS : Object.keys(store);
	ctx.throw(405, undefined, {
		headers: {
			Allow: allowed.join(', ').toUpperCase()
		}
	});
}


function handleOptions(ctx, next, store) {
	const allowed = store.all ? METHODS : Object.keys(store);
	ctx.set('Allow', allowed.join(', ').toUpperCase());
	ctx.status = 204;
}


// Events

/**
 * Call the {@link Router#_update} method of each {@link Router} that
 * has this Router nested.
 * @private
 */
Router.prototype._updateParents = function() {
	for(const parent of this._parents)
		parent._update();
}


/**
 * Re-build the internal route and middleware cache with updated data
 * and then call {@link Router#_updateParents}.
 * @private
 */
Router.prototype._update = function() {
	const live = this._live;

	if ( live )
		this._routers = [];
		/*if ( this._router )
			this._router.reset();
		else
			this._router = FindMyWay(this.opts.findMyWay);*/

	const prefix = this.opts.prefix || '',
		name = this.opts.name,
		host = this.opts.host,
		hosts = new Map,
		routes = this._routes = new Map,
		named = this._named = {},
		middlewares = this._middlewares = {};

	// Route and Middleware Merging
	mergeRoutes(routes, host, name, prefix, this.routes);
	mergeMiddlewares(middlewares, prefix, this.middlewares);

	for(const [nest_path, nested] of Object.entries(this._nested))
		for(const router of nested) {
			const pref = `${prefix}${nest_path || ''}`;

			mergeRoutes(routes, host, name, pref, router._routes);
			mergeMiddlewares(middlewares, pref, router._middlewares);
		}


	// Convert all middleware paths to special regex so that we can easilly
	// determine which middleware should be associated with which routes.
	const middleware_tokens = Object.entries(middlewares).map(([route, data]) =>
		[pathToRegexp.parse(route), route, data]
	);

	const dataware = Object.entries(this.datawares);

	// Now, we want to build our final routing data. This data is kept
	// on our find-my-way router instance. We're also going to apply
	// any dataware at this stage.
	for(const [host, hosted_routes] of routes.entries()) {
		for(const [route, data] of Object.entries(hosted_routes)) {
			const route_tokens = pathToRegexp.parse(route),
				route_fn = pathToRegexp.tokensToFunction(route_tokens),
				route_params = route_tokens
					.filter(token => typeof token !== 'string')
					.map(token => token.name),

				matching_pware = data._paramware = data._paramware || [],
				md = this._matchMiddleware(route, middleware_tokens),
				new_data = {};

			let route_host;

			for(const name of route_params) {
				const pware = this.paramwares[name];
				if ( pware )
					for(const pw of pware)
						matching_pware.push(pw);
			}

			// We need to know the host ahead of time because of URL generation,
			// so check for an override right now.
			for(const d of Object.values(data)) {
				if ( d.options && d.options.host ) {
					if ( route_host != null )
						throw new Error(`Route has conflicting hosts: ${route}`);

					route_host = d.options.host;
				}
			}

			if ( route_host == null )
				route_host = host;

			let host_info = hosts.get(route_host);
			if ( ! host_info ) {
				hosts.set(route_host, host_info = {});
				if ( route_host ) {
					host_info.tokens = pathToRegexp.parse(route_host, HOST_OPTS);
					host_info.rich = host_info.tokens.length > 1 || typeof host_info.tokens[0] != 'string';
					if ( host_info.rich ) {
						host_info.vars = [];
						host_info.reverse = pathToRegexp.compile(route_host, HOST_OPTS);
						host_info.matcher = pathToRegexp.tokensToRegExp(host_info.tokens, host_info.vars, HOST_OPTS);

						for(let i=0, l = host_info.vars.length; i < l; i++)
							host_info.vars[i] = host_info.vars[i] && host_info.vars[i].name;
					}
				}
			}

			for(const [key, d] of Object.entries(data)) {
				if ( key.startsWith('_') )
					continue;

				if ( d.options && d.options.name ) {
					const name = d.name_prefix ?
						`${d.name_prefix}.${d.options.name}` :
						d.options.name;

					named[name] = [route_params, route_fn, host_info.rich, route_host, host_info.vars, host_info.reverse];
				}

				const matching_defaults = d.defaults = d.defaults || {};
				for(const [dkey, value] of Object.entries(this.dataware_default)) {
					if ( ! has(matching_defaults, dkey) )
						matching_defaults[dkey] = value;
				}

				const matching_dware = d.dataware = d.dataware || [];
				for(const [dkey, dware] of dataware) {
					if ( ! d.exclusive.includes(dkey) && (has(d.options, dkey) || has(matching_defaults, dkey)) )
						for(const dw of dware)
							matching_dware.push([dkey, dw, this.dataware_sort[dkey]]);
				}

				for(const dkey of this.dataware_exclusive)
					d.exclusive.push(dkey);

				if ( live ) {
					// Construct our list of dataware methods.
					// Dataware constructors are allowed to return more
					// than one function to be composed, and they
					// can have custom sorting.
					const dware = [];
					for(const [dkey, dw, sort] of matching_dware) {
						const data = has(d.options, dkey) ? d.options[dkey] : matching_defaults[dkey],
							out = dw(data, route, d);
						if ( ! out )
							continue;

						if ( Array.isArray(out) ) {
							for(const thing of out) {
								if ( ! thing )
									continue;

								if ( ! thing.sort )
									thing.sort = sort;

								dware.push(thing);
							}

						} else {
							if ( ! out.sort )
								out.sort = sort;

							dware.push(out);
						}
					}

					dware.sort((a, b) => {
						a = a && a.sort || 0;
						b = b && b.sort || 0;

						return a - b;
					});

					new_data[key] = Object.assign({}, d, {
						fn: this.opts.paramwareBeforeDataware ?
							compose(md, matching_pware, dware, d.middleware) :
							compose(md, dware, matching_pware, d.middleware)
					})
				}
			}

			if ( live ) {
				if ( ! host_info.router ) {
					const router = host_info.router = FindMyWay(this.opts.FindMyWay);

					if ( host_info.tokens ) {
						if ( host_info.rich ) {
							this._routers.push([1, host_info.matcher, router, pluckVars(host_info.vars)]);
						} else
							this._routers.push([0, route_host.toLowerCase(), router]);

					} else
						this._routers.push([-1, null, router]);
				}

				host_info.router.on('GET', route, NOOP, new_data);
			}
		}
	}

	// Now, let all this trickle down to our parents.
	this._updateParents();
}

/**
 * Pre-calculate which middleware could potentially run on a specific
 * route so that we can minimize the middleware that actually run on
 * any given route.
 *
 * @private
 * @param {String} path The path for the route we're checking
 * @param {Array} middlewares An array of middleware descriptions, including
 * tokens, the raw route, and the middleware functions themselves
 * @returns {Array} The matching middleware to be applied to the route.
 */
Router.prototype._matchMiddleware = function(path, middlewares) {
	const out = [],
		// This works slightly differently than find-my-way's
		// route parsing, but hopefully it's close enough to
		// make middleware matching work.
		tokens = pathToRegexp.parse(path),
		match_fn = this.opts.middlewareMatcher || couldMatch;

	for(const [middle_tokens, r, data] of middlewares) {
		if ( match_fn(tokens, middle_tokens) ) {
			const filtered = r && r.length > 0,
				rich = filtered && r.includes(':'),
				compiled = rich ? pathToRegexp(r) : r;

			for(const middleware of data)
				out.push({
					filtered,
					rich,
					test: compiled,
					fn: middleware
				});
		}
	}

	return out;
}


function pluckVars(vars) {
	if ( ! Array.isArray(vars) || ! vars.length )
		return null;

	const len = vars.length,
		keys = vars.map(v => v.name || v);

	return match => {
		const plucked = {};
		if ( match && match.length ) {
			for(let i=0; i < len; i++)
				plucked[keys[i]] = match[i + 1];
		}

		return plucked;
	}
}


function couldMatch(tokens, middle_tokens) {
	// TODO: Make this way smarter.
	// Right now, we're just comparing the first tokens. And then,
	// we're only comparing them if they're both strings.
	// If nothing else, we should try to count segments.

	//const len = tokens.length,
	//	mid_len = middle_tokens.length;

	const i=0, j=0;

	//while(i < len || j < mid_len) {
	const token = tokens[i],
		mid_token = middle_tokens[j];

	if ( ! token )
		return false;

	if ( typeof token === 'string' && typeof mid_token === 'string' ) {
		if ( token !== mid_token && ! token.startsWith(`${mid_token}/`) )
			return false;
	}

	/*i++;
		j++;*/
	//}

	return true;
}


function mergeRoutes(output, host, name, prefix, routes) {
	if ( Array.isArray(routes) )
		routes = [[host, routes]];
	else if ( routes instanceof Map )
		routes = Array.from(routes.entries());
	else
		routes = Object.entries(routes);

	const mapped = output instanceof Map;

	for(const [route_host, host_data] of routes) {
		const use_host = route_host || host;
		let hosted;
		if ( mapped ) {
			hosted = output.get(use_host);
			if ( ! hosted )
				output.set(use_host, hosted = {});
		} else
			hosted = output[use_host] = output[use_host] || {};

		const host_routes = Array.isArray(host_data) ? host_data : Object.entries(host_data);

		for(const data of host_routes) {
			let paths = data[0];
			if ( ! Array.isArray(paths) )
				paths = [paths];

			for(const p of paths) {
				const prefixed = `${prefix}${p}`,
					out = hosted[prefixed] = hosted[prefixed] || {};

				for(const [method, rdata] of Object.entries(data[1])) {
					if ( method.startsWith('_') ) {
						if ( Array.isArray(rdata) )
							out[method] = Array.from(rdata);
						else if ( typeof rdata === 'object' )
							out[method] = Object.assign({}, rdata);
						else
							out[method] = rdata;

						continue;
					}

					let name_prefix = rdata.name_prefix;
					if ( name )
						name_prefix = name_prefix ? `${name}.${name_prefix}` : name;

					out[method] = Object.assign(
						{},
						rdata,
						{
							name_prefix,
							dataware: rdata.dataware ? Array.from(rdata.dataware) : [],
							exclusive: rdata.exclusive ? Array.from(rdata.exclusive) : [],
							defaults: rdata.defaults ? Object.assign({}, rdata.defaults) : {}
						}
					);
				}
			}
		}
	}

	return output;
}


function mergeMiddlewares(output, prefix, middlewares) {
	if ( ! Array.isArray(middlewares) )
		middlewares = Object.entries(middlewares);

	for(const data of middlewares) {
		let paths = data[0];
		if ( ! Array.isArray(paths) )
			paths = [paths];

		for(const p of paths) {
			const prefixed = `${prefix}${p}`,
				out = output[prefixed] = output[prefixed] || [];

			for(const middleware of Array.isArray(data[1]) ? data[1] : [data[1]])
				out.push(middleware);
		}
	}

	return output;
}


// Registering Routes

/*
 * Valid Method Signatures
 *
 * this.get('/blah/:id', ctx => { })
 * this.get(['/blah:id'], ctx => { })
 * this.get('/blah/:id', (ctx, next) => { }, ctx => { })
 * this.get(['/blah:id'], (ctx, next) => { }, ctx => { })
 * this.get('name', '/blah/:id', ctx => { })
 * this.get('name', ['/blah:id'], ctx => { })
 * this.get('name', '/blah/:id', (ctx, next) => { }, ctx => { })
 * this.get('name', ['/blah:id'], (ctx, next) => { }, ctx => { })
 *
 * this.get('/blah/:id', {opts: true}, ctx => { })
 * this.get(['/blah:id'], {opts: true}, ctx => { })
 * this.get('/blah/:id', {opts: true}, (ctx, next) => { }, ctx => { })
 * this.get(['/blah:id'], {opts: true}, (ctx, next) => { }, ctx => { })
 * this.get('name', '/blah/:id', {opts: true}, ctx => { })
 * this.get('name', ['/blah:id'], {opts: true}, ctx => { })
 * this.get('name', '/blah/:id', {opts: true}, (ctx, next) => { }, ctx => { })
 * this.get('name', ['/blah:id'], {opts: true}, (ctx, next) => { }, ctx => { })
 */

METHODS.concat('all').forEach(method => {
	/**
	* Match URL paths to middleware using `router.METHOD()` where `method` is an HTTP method,
	* such as GET, POST, or DELETE. The special method `router.all()` will match all methods.
	*
	* When a route is matched, the route's options will be available at `ctx.state.route`.
	*
	* Route paths are passed directly to an internal [find-my-way](https://www.npmjs.com/package/find-my-way)
	* instance and should be written using that syntax. This syntax, for the most part,
	* mirrors that used by [path-to-regexp](https://github.com/pillarjs/path-to-regexp).
	*
	* If supplied, hosts are parsed with `path-to-regexp`. Hosts without variables are checked
	* with simple string comparison while hosts with variables are matched with a regular
	* expression generated by `path-to-regexp`.
	*
	* Any variables within the host will be stored in `ctx.host_params` and `ctx.request.host_params`.
	*
	* @example
	* router
	*     .get('/', (ctx, next) => {
	*         ctx.body = "Hello, World!"
	*     })
	*     .post('user', '/user/:userID', (ctx, next) => {
	*         // ...
	*     })
	*     .del('/topic/:topicID/message/:messageID', {some_data: false}, (ctx, next) => {
	*         // ...
	*     })
	*
	* @alias METHOD
	* @memberof Router.prototype
	* @param {String} [name] A name for this route. Equivilent to setting a name key in options.
	* @param {String|String[]} path A path or multiple paths that these middleware functions will match.
	* @param {Object} [options] Optional data to associate with the route, including a name and data for data-based middleware.
	* @param {String} [options.host] Optional host for this specific route. Different methods on the same route must use the same host.
	* @param {...Function} middleware Middleware functions to handle this route.
	* @returns {Router} The router
	*/
	Router.prototype[method] = function(name, path, options, ...middleware) {
		// If the first parameter is a string, whether or not it's a name
		// depends on whether or not the second parameter is a path, which
		// can be a string or an array of strings.

		// It's more efficient to check the type of the second parameter directly.
		if ( typeof path !== 'string' && ! Array.isArray(path) ) {
			if ( options != null )
				middleware.unshift(options);

			options = path;
			path = name;
			name = null;
		}

		// If options is a function, it's middleware and not actual options.
		if ( typeof options === 'function' ) {
			middleware.unshift(options);
			options = {};

		} else if ( typeof options !== 'object' || Array.isArray(options) )
			throw new TypeError('options must be an object');

		for(const fn of middleware)
			if ( typeof fn !== 'function' )
				throw new TypeError('middleware must be functions')

		options.name = name;

		this.register([method], path, options, ...middleware);
		return this;
	}
})

// Alias of Router.delete because `delete` is a reserved word.
Router.prototype.del = Router.prototype['delete'];


/**
 * Register a new route and update the router's internal state.
 *
 * @example
 * router.register('get', '/', null, ctx => {
 *     ctx.body = "Hello, World!"
 * })
 *
 * @param {String|String[]} methods The HTTP methods that these middleware functions can handle.
 * @param {String|String[]} path A path or multiple paths that these middleware functions will match.
 * @param {Object|null} options Optional data to associate with the route, including a name and data for data-based middleware.
 * @param {String} [options.host] Optional host for this specific route. Different methods on the same route must use the same host.
 * @param {...Function} middleware Middleware functions to handle this route.
 * @returns {Router} The Router
 */
Router.prototype.register = function(methods, path, options, ...middleware) {
	if ( ! Array.isArray(methods) )
		methods = [methods];

	for(const method of methods)
		if ( typeof method !== 'string' )
			throw new TypeError('method must be a string');

	if ( ! Array.isArray(path) )
		path = [path];

	for(const p of path)
		if ( typeof p !== 'string' )
			throw new TypeError('path must be a string or array of strings');

	if ( options == null )
		options = {};
	else if ( typeof options !== 'object' || Array.isArray(options) )
		throw new TypeError('options must be an object');

	for(const fn of middleware)
		if ( typeof fn !== 'function' )
			throw new TypeError('middleware must be a function or array of functions');

	const route = {};
	for(const method of methods)
		route[method.toLowerCase()] = {options, middleware};

	this.routes.push([path, route]);
	this._update();
	return this;
}


// Registering Middleware

/**
 * Use the given middleware. Middleware are run in the order they are defined.
 * This can also be used to nest another {@link Router} as a child of this
 * router.
 *
 * @example
 * router.use(SomeMiddleware);
 * router.use('/user', SomeUserMiddleware);
 * router.use(anotherRouter);
 *
 * @param {String|String[]} [path] A path or array of paths to limit the middleware to
 * @param {...(Function|Router)} middleware The middleware function(s) to use
 * @returns {Router} The Router
 */
Router.prototype.use = function(path, ...middleware) {
	if ( typeof path === 'function' || path instanceof Router ) {
		middleware.unshift(path);
		path = '';
	}

	if ( ! Array.isArray(path) )
		path = [path];

	for(const p of path)
		if ( typeof p !== 'string' )
			throw new TypeError('path must be a string or array of strings');

	for(const fn of middleware)
		if ( !(fn instanceof Router) && typeof fn !== 'function' )
			throw new TypeError('middleware must be a function or Router instance');

	const mids = [];

	for(let fn of middleware) {
		if ( typeof fn === 'function' && fn.router instanceof Router )
			fn = fn.router;

		if ( fn instanceof Router ) {
			this._nest(path, fn);
		} else
			mids.push(fn);
	}

	if ( mids.length )
		this.middlewares.push([path, mids]);

	this._update();
	return this;
}

/**
 * Use constructed middleware on routes with the provided data key. Constructors
 * registered using this method are executed when pre-calculating a route's middleware
 * chain. The constructors are expected to return a middleware function or array of
 * functions. These functions will be run after general middleware registered
 * via {@link Router#use} but before the middleware functions registered for a route.
 *
 * By setting a `sort` property on the returned middleware method, it is possible
 * to override the sorting for that specific method.
 *
 * @example
 * router.useData('headers', headers => {
 *     return async (ctx, next) => {
 *         await next();
 *         ctx.set(headers);
 *     }
 * });
 *
 * router.useData('validation', -1, options => {
 *     const postFn = (ctx, next) => {
 *         // This runs after headers
 *         await next();
 *     };
 *
 *     // Make postFn run later
 *     postFn.sort = 2;
 *
 *     return [
 *         async (ctx, next) => {
 *             // This runs before headers
 *             await next();
 *         },
 *         postFn
 *     ];
 * });
 *
 * router.get('/', {
 *     headers: {
 *         'Access-Control-Allow-Origin': '*'
 *     },
 *     validation: true
 * }, ctx => {
 *     ctx.body = "Hello, World!";
 * });
 *
 * @param {String} key The data key to match
 * @param {Number} [sort_value=0] A number to use for this data-based middleware when
 * sorting to determine which to apply first. Lower values execute first.
 * @param {...Function} constructor The middleware constructor function(s) to use
 * @returns {Router} The Router
 */
Router.prototype.useData = function(key, sort_value, ...constructor) {
	if ( typeof key !== 'string' )
		throw new TypeError('key must be a string');

	if ( typeof sort_value === 'function' ) {
		constructor.unshift(sort_value);
		sort_value = 0;
	} else if ( typeof sort_value === 'number' )
		this.dataware_sort[key] = sort_value;
	else
		throw new TypeError('sort_value must be a number');

	for(const fn of constructor)
		if ( typeof fn !== 'function' )
			throw new TypeError('middleware must be a function');

	const dws = this.datawares[key] = this.datawares[key] || [];
	for(const fn of constructor)
		dws.push(fn);

	this._update();
	return this;
}

/**
 * This allows you to set default data which is used for all routes that do not
 * have existing data set for a specific data-based middleware.
 *
 * @example
 * // For an example of how to write a simple cache dataware,
 * // check out the project README.
 * router.useData('cache', duration => {
 *     // duration is the number of seconds
 *     // <cache logic goes here>
 *     return cache_middleware;
 * });
 *
 * // We default to a 60 second cache.
 * router.defaultData('cache', 60);
 *
 * router.get('/', ctx => {
 *     ctx.body = 'This uses the default cache of 60 seconds: ' + Date.now();
 * });
 *
 * router.get('/fast', {cache: 5}, ctx => {
 *     ctx.body = 'This is only cached for 5 seconds: ' + Date.now();
 * });
 *
 * @param {String} key The data key
 * @param {Object} value The default value to set. `undefined` to remove.
 * @returns {Router} The Router
 */
Router.prototype.defaultData = function(key, value) {
	if ( typeof key !== 'string' )
		throw new TypeError('key must be a string');

	if ( value === undefined )
		delete this.dataware_default[key];
	else
		this.dataware_default[key] = value;

	this._update();
	return this;
}

/**
 * This allows you to override the order in which data-based middleware are
 * applied. You can also provide this value when defining your data-based
 * middleware constructors with {@link Router#useData}.
 *
 * @param {String} key The data key
 * @param {Number} [sort_value=0] A number to use for this data-based
 * middleware when sorting to determine which to apply first. Lower values
 * execute first.
 * @returns {Router} The Router
 */
Router.prototype.sortData = function(key, sort_value = 0) {
	if ( typeof key !== 'string' )
		throw new TypeError('key must be a string');

	if ( typeof sort_value !== 'number' )
		throw new TypeError('sort_value must be a number');

	this.dataware_sort[key] = sort_value;
	this._update();
	return this;
}

/**
 * This method allows you to mark a specific key for data-based middleware as
 * exclusive. This will prevent a parent's data-based middleware from being
 * applied to the routes of a nested {@link Router}.
 *
 * The default `mount` middleware is set to exclusive to prevent multiple copies
 * of the mount middleware being applied to matching routes.
 * @param {String} key The data key
 * @param {Boolean} [exclusive=true] Whether or not data-based middleware for
 * the provided key should be exclusive.
 * @returns {Router} The Router
 */
Router.prototype.setDataExclusive = function(key, exclusive = true) {
	if ( typeof key !== 'string' )
		throw new TypeError('key must be a string');

	if ( typeof exclusive !== 'boolean' )
		throw new TypeError('exclusive must be a bool');

	if ( exclusive )
		this.dataware_exclusive.add(key);
	else
		this.dataware_exclusive.delete(key);

	this._update();
	return this;
}

/**
 * Use middleware for a named route parameter. This is useful for
 * automatically loading data or performing validation for commonly used
 * route parameters.
 *
 * @example
 * router.param('userID', async (userID, ctx, next) => {
 *     ctx.user = await Users.query().where('id', userID);
 *     return next();
 * });
 *
 * router.get('/user/:userID', ctx => {
 *     // ... do something with ctx.user
 * });
 *
 * @param {String} param The name of the parameter to handle.
 * @param {...Function} middleware The middleware to apply to that parameter.
 */
Router.prototype.param = function(param, ...middleware) {
	if ( typeof param !== 'string' )
		throw new TypeError('param must be a string');

	for(const fn of middleware)
		if ( typeof fn !== 'function' )
			throw new TypeError('middleware must be a function');

	const pws = this.paramwares[param] = this.paramwares[param] || [];
	for(const fn of middleware)
		pws.push((ctx, next) => fn(ctx.params[param], ctx, next));

	this._update();
}

/**
 * Mount the given middleware at a specific path. This will register the
 * middleware for all HTTP methods on the given route, and strip the path
 * from `ctx.path` temporarilly when calling the middleware.
 *
 * Internally, this acts by setting the option `{mount: '*'}` on the generated
 * route while also ensuring the path ends with `/*`. This method will not
 * function correctly if the built-in mount middleware is disabled.
 *
 * @param {String|String[]} path The path to mount the middleware at.
 * @param {Object} [options] An optional set of options for the middleware.
 * @param {...Function} middleware The middleware function(s) to use
 * @returns {Router} The Router
 */
Router.prototype.mount = function(path, options, ...middleware) {
	if ( ! Array.isArray(path) )
		path = [path];

	if ( typeof options === 'function' ) {
		middleware.unshift(options);
		options = null;
	} else if ( typeof options !== 'object' )
		throw new TypeError('options must be an object');

	for(const p of path)
		if ( typeof p !== 'string' )
			throw new TypeError('path must be a string or array of strings');

	for(const fn of middleware)
		if ( typeof fn !== 'function' )
			throw new TypeError('middleware must be a function');

	if ( options )
		options = Object.assign({}, options, {mount: '*'});
	else
		options = {mount: '*'};

	this.register(['all'], path.map(p => {
		if ( p.endsWith('/') )
			return `${p}*`;

		else if ( ! p.endsWith('/*') )
			return `${p}/*`;

		return p;

	}), options, ...middleware);

	return this;
}


/**
 * Nest another {@link Router} as a child of this router, inheriting all of
 * its routes, middleware, etc.
 *
 * @example
 * const users = Router({prefix: '/user'});
 *
 * users.get('/:userID', ctx => {
 *     // ...
 * });
 *
 * router.nest(users);
 *
 * @param {String|String[]} [path] The path to nest the router at.
 * @param {Router} router The router instance to be nested.
 * @returns {Router} The Router
 */
Router.prototype.nest = function(path, router) {
	if ( path instanceof Router ) {
		router = path;
		path = null;
	}

	this._nest(path, router);
	this._update();
	return this;
}

Router.prototype._nest = function(path, router) {
	if ( ! path )
		path = [''];

	if ( ! Array.isArray(path) )
		path = [path];

	for(const p of path)
		if ( typeof p !== 'string' )
			throw new TypeError('path must be a string or array of strings');

	if ( !(router instanceof Router) )
		throw new TypeError('router must be a Router');

	for(const p of path) {
		const nests = this._nested[p] = this._nested[p] || [];
		if ( ! nests.includes(router) )
			nests.push(router);
	}

	if ( ! router._parents.includes(this) )
		router._parents.push(this);
}


/**
 * Generate a URL for the route with the given name.
 *
 * Routes will inherit the name of the {@link Router} that contains them. As
 * a shortcut for accessing other routes in the same namespace, you can start
 * the name passed to `urlFor` with a period.
 *
 * `urlFor` is assigned to the current Koa context and should be used there
 * to ensure namespaces work correctly.
 *
 * Once the URL has been built (using
 * [path-to-regexp](https://github.com/pillarjs/path-to-regexp)) that generated
 * URL and any left over parameters are merged into `options` and the structure
 * is passed to [url.format()](https://nodejs.org/api/url.html#url_url_format_urlobject)
 *
 * If the Router or specific route is using a host, and a host hasn't been specified
 * in options, the host will be checked against `source_host`. If the host does not
 * match, an absolute URL will be generated.
 *
 * Any host variables for the route must be included in `params`.
 *
 * @example
 * const router = Router(),
 *       user_router = Router({name: 'user', prefix: '/user'});
 *
 * user_router.get('me', '/me', ctx => {
 *     ctx.redirect(ctx.urlFor('.id', ctx.state.current_user.id));
 * });
 *
 * user_router.get('id', '/:userID', ctx => {
 *     // ...
 * });
 *
 * router.use(user_router);
 *
 * router.get('/', ctx => {
 *     ctx.redirect(ctx.urlFor('user.me'));
 * });
 *
 * @param {String} name The name of the route
 * @param {Object} [params] Parameters to place in the generated URL.
 * Required if the route takes parameters. Any parameter not consumed in the route
 * will be added as a query parameter.
 * @param {Object} [options] Options to pass to `url.format()`.
 * @param {Object} [options.query] Query parameters for the generated URL.
 * @param {Object} [options.absolute=false] If set to true, the generated URL will always be absolute.
 * @param {String} [source_host] The host from the request that triggered this method.
 * @param {String} [source_protocol] The protocol from the request that triggered this method.
 * @returns {String} The generated URL.
 */
Router.prototype.urlFor = function(name, params = {}, options = {}, source_host, source_protocol) {
	if ( ! this._named[name] )
		throw new Error('No such named route');

	if ( options == null )
		options = {};
	else if ( typeof options !== 'object' )
		throw new TypeError('Invalid options for urlFor: must be object');

	const [known_params, fn, host_rich, host, host_vars, host_fn] = this._named[name],
		query = options.query = options.query || {};

	if ( params == null )
		params = {};
	else if ( typeof params !== 'object' )
		throw new TypeError('Invalid parameters for urlFor: must be object');

	for(const [name, val] of Object.entries(params)) {
		if ( ! known_params.includes(name) && !( host_vars && host_vars.includes(name)) )
			query[name] = val;
	}

	if ( ! options.host ) {
		let url_host;
		if ( host_rich && host_fn )
			url_host = host_fn(params);
		else if ( ! host_rich && host )
			url_host = host;

		if ( ! url_host )
			url_host = this.opts.host || source_host;

		if ( url_host && (options.absolute || url_host !== source_host) ) {
			options.absolute = undefined;
			options.host = url_host;

			if ( options.slashes == null )
				options.slashes = true;

			if ( options.slashes && options.protocol == null && source_protocol )
				options.protocol = source_protocol;
		}
	}

	options.pathname = fn(params);
	return formatURL(options);
}


Router.Mount = Mount;
Router.compose = compose;
