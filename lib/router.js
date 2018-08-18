/**
 * Fast resource routing middleware for Koa
 *
 * @author SirStendec <sir@stendec.me>
 * @link https://github.com/frankerfacez/api-router
 */

const debug = require('debug')('ffz-api-router');
const FindMyWay = require('find-my-way');
const pathToRegexp = require('path-to-regexp');
const METHODS = require('methods');
const formatURL = require('url').format;
const reuse = require('reusify');

const compose = require('./composor');
const Mount = require('./mount');

const NOOP = () => {};

module.exports = Router;

/**
 * Create a new Router.
 *
 * @constructor
 * @param {Object} [opts] Options for initializing this Router and the internal find-my-way router.
 * @param {String} [opts.name] An optional name for this router. Used when resolving a route for URL generation.
 * @param {String} [opts.prefix] Prefix all paths for this Router
 * @param {Object} [opts.findMyWay] Options to provide to the internal find-my-way router.
 * @param {Boolean} [opts.paramwareBeforeDataware=false] If this is true, middleware registered for specific params will run before dataware.
 * @param {Function} [opts.mountMiddleware] Middleware to use for @{link Router.mount} instead of the built-in Mount.
 * @param {Boolean|Function} [opts.handleOptions] Whether or not to handle OPTIONS requests. Optionally takes a function to handle OPTIONS.
 * @param {Boolean|Function} [opts.handle405] Whether or not to generate 405 responses when there are no matching methods for a route. Optionally takes a function to handle 405s.
 */
function Router(opts) {
	if ( !(this instanceof Router) )
		return new Router(opts);

	this.opts = opts || {};
	this.opts.paramwareBeforeDataware = this.opts.paramwareBeforeDataware || false;
	this.opts.mountMiddleware = this.opts.mountMiddleware || Mount;

	// Routers that we interact with.
	this._parents = [];
	this._nested = {};

	// Content defined on *this* Router.
	this.routes = [];
	this.middlewares = [];

	this.paramwares = {};

	this.datawares = {
		mount: [Mount]
	};

	this.dataware_sort = {};

	// Internals
	this._router = null;
	this._routes = {};
	this._named = {};
	this._middlewares = {};
}

// Middleware

Router.prototype.middleware = function() {
	const router = this;

	// Context URL Generation
	let pool;

	function URLFor() {
		this.context = null;

		const that = this;

		this.urlFor = function(name, params) {
			return router.urlFor(name, params)
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

		const method = ctx.method.toLowerCase(),
			rt = router._router,
			match = rt && rt.find('GET', ctx.path);

		if ( ! match ) {
			if ( has_timers )
				ctx.stopTimer('routing');
			return next();
		}

		const {params, store} = match;
		const data = store[method] || (method !== 'options' && store.all);

		ctx.request.params = ctx.params = params;
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
		if ( method === 'options' && router.opts.handleOptions !== false ) {
			fn = router.opts.handleOptions || handleOptions;

		} else if ( router.opts.handle405 === false ) {
			if ( has_timers )
				ctx.stopTimer('routing');

			return Promise.resolve(next()).then(urls.done).catch(urls.catch);

		} else
			fn = router.opts.handle405 || handle405;

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
 * Call the @{link Router._update} method of each @{link Router} that
 * has this Router nested.
 */
Router.prototype._updateParents = function() {
	for(const parent of this._parents)
		parent._update();
}


/**
 * Re-build the internal route and middleware cache with updated data
 * and then call @{link Router._updateParents}.
 */
Router.prototype._update = function() {
	if ( this._router )
		this._router.reset();
	else
		this._router = FindMyWay(this.opts.findMyWay);

	const prefix = this.opts.prefix || '',
		name = this.opts.name,
		routes = this._routes = {},
		named = this._named = {},
		middlewares = this._middlewares = {};

	// Route and Middleware Merging
	mergeRoutes(routes, name, prefix, this.routes);
	mergeMiddlewares(middlewares, prefix, this.middlewares);

	for(const [nest_path, nested] of Object.entries(this._nested))
		for(const router of nested) {
			const pref = `${prefix}${nest_path || ''}`;

			mergeRoutes(routes, name, pref, router._routes);
			mergeMiddlewares(middlewares, pref, router._middlewares);
		}


	// Convert all middleware paths to special regex so that we can easilly
	// determine which middleware should be associated with which routes.
	const middleware_tokens = Object.entries(middlewares).map(([route, data]) =>
		[pathToRegexp.parse(route), route, data]
	);


	// Sort our dataware.
	const dataware = Object.entries(this.datawares).sort((a,b) => {
		a = this.dataware_sort[a[0]] || 0;
		b = this.dataware_sort[b[0]] || 0;

		return a - b;
	});


	// Build functions for our paramware
	const paramware = {};
	for(const [param, pwares] of Object.entries(this.paramwares)) {
		const pws = paramware[param] = [];
		for(const pw of pwares)
			pws.push((ctx, next) => pw(ctx.params[param], ctx, next));
	}


	// Now, we want to build our final routing data. This data is kept
	// on our find-my-way router instance. We're also going to apply
	// any dataware at this stage.
	for(const [route, data] of Object.entries(routes)) {
		const route_tokens = pathToRegexp.parse(route),
			route_fn = pathToRegexp.tokensToFunction(route_tokens),
			route_params = route_tokens
				.filter(token => typeof token !== 'string')
				.map(token => token.name),

			matching_pware = [],
			md = this.matchMiddleware(route, middleware_tokens),
			new_data = {};

		for(const name of route_params) {
			const pware = paramware[name];
			if ( pware )
				for(const pw of pware)
					matching_pware.push(pw);
		}

		for(const [key, d] of Object.entries(data)) {
			if ( d.options && d.options.name )
				named[d.options.name] = [route_params, route_fn];

			const matching_dware = [];
			for(const [dkey, dware] of dataware) {
				if ( d.options[dkey] )
					for(const dw of dware)
						matching_dware.push(dw(d.options[dkey], route, d));
			}

			new_data[key] = Object.assign({}, d, {
				fn: this.opts.paramwareBeforeDataware ?
					compose(md, matching_pware, matching_dware, d.middleware) :
					compose(md, matching_dware, matching_pware, d.middleware)
			})
		}

		this._router.on('GET', route, NOOP, new_data);
	}

	// Now, let all this trickle down to our parents.
	this._updateParents();
}

/**
 * Pre-calculate which middleware could potentially run on a specific
 * route so that we can minimize the middleware that actually run on
 * any given route.
 *
 * @param {String} path The path for the route we're checking
 * @param {Array} middlewares An array of middleware descriptions, including
 * tokens, the raw route, and the middleware functions themselves
 * @returns {Array} The matching middleware to be applied to the route.
 */
Router.prototype.matchMiddleware = function(path, middlewares) {
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


function mergeRoutes(output, name, prefix, routes) {
	if ( ! Array.isArray(routes) )
		routes = Object.entries(routes);

	for(const data of routes) {
		let paths = data[0];
		if ( ! Array.isArray(paths) )
			paths = [paths];

		for(const p of paths) {
			const prefixed = `${prefix}${p}`;
			output[prefixed] = Object.assign(
				output[prefixed] || {},
				data[1]
			)
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

/**
 * Match URL paths to middleware using `router.method()` where `method` is an HTTP method,
 * such as GET, POST, or DELETE. The special method `router.all()` will match all methods.
 *
 * ```javascript
 * router
 *     .get('/', (ctx, next) => {
 *         ctx.body = "Hello, World!"
 *     })
 *     .post('/user/:userID', (ctx, next) => {
 *         // ...
 *     })
 *     .del('/topic/:topicID/message/:messageID', (ctx, next) => {
 *         // ...
 *     })
 * ```
 *
 * When a route is matched, the route's options will be available at `ctx.state.route`.
 *
 * Route paths are passed directly to an internal [find-my-way](https://www.npmjs.com/package/find-my-way)
 * instance and should be written using that syntax. This syntax, for the most part,
 * mirrors that used by [path-to-regexp](https://github.com/pillarjs/path-to-regexp).
 *
 * @name get|put|post|patch|delete|del|all
 * @memberof Router.prototype
 * @param {String} [name] A name for this route. Equivilent to setting a name key in options.
 * @param {String|String[]} path A path or multiple paths that these middleware functions will match.
 * @param {Object} [options] Optional data to associate with the route, including a name and data for dataware.
 * @param {...Function} middleware Middleware functions to handle this route.
 * @returns {Router} The router
 */
METHODS.concat('all').forEach(method => {
	Router.prototype[method] = function(name, path, options, ...middleware) {
		// If the first parameter is a string, whether or not it's a name
		// depends on whether or not the second parameter is a path, which
		// can be a string or an array of strings.

		// It's more efficient to check the type of the second parameter directly.
		if ( ! Array.isArray(path) ) {
			if ( typeof path !== 'string' ) {
				if ( options )
					middleware.unshift(options);

				options = path;
				path = name;
				name = null;
			}

		} else
			for(const p of path)
				if ( typeof p !== 'string' )
					throw new TypeError('path must be a string or array of strings');

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
 * @param {String|String[]} methods The HTTP methods that these middleware functions can handle.
 * @param {String|String[]} path A path or multiple paths that these middleware functions will match.
 * @param {Object} options Optional data to associate with the route, including a name and data for dataware.
 * @param {...Function} middleware Middleware functions to handle this route.
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

	if ( ! options )
		options = {};
	else if ( typeof options !== 'object' || Array.isArray(options) )
		throw new TypeError('options must be an object');

	if ( ! Array.isArray(middleware) )
		middleware = [middleware];

	for(const fn of middleware)
		if ( typeof fn !== 'function' )
			throw new TypeError('middleware must be a function or array of functions');

	const route = {};
	for(const method of methods)
		route[method.toLowerCase()] = {options, middleware};

	this.routes.push([path, route]);
	this._update();
}


// Registering Middleware

/**
 * Use the given middleware. Middleware are run in the order they are defined.
 * This can also be used to nest another @{link Router} as a child of this
 * router.
 * @param {String|String[]} [path] A path or array of paths to limit the middleware to
 * @param {...Function|Router} middleware The middleware function(s) to use
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
}

/**
 * Use the given middleware on routes with the provided data key. Middleware
 * registered using this are run after general middleware registered
 * via @{link Router#use} but before the middleware functions registered for a route.
 *
 * @param {String} key The data key to match
 * @param {...Function} middleware The middleware function(s) to use
 */
Router.prototype.useData = function(key, ...middleware) {
	if ( typeof key !== 'string' )
		throw new TypeError('key must be a string');

	for(const fn of middleware)
		if ( typeof fn !== 'function' )
			throw new TypeError('middleware must be a function');

	const dws = this.datawares[key] = this.datawares[key] || [];
	for(const fn of middleware)
		dws.push(fn);

	this._update();
}

/**
 * This allows you to override the order in which dataware are applied.
 * @param {String} key The data key
 * @param {Number} value The number to sort the specified dataware with
 */
Router.prototype.sortData = function(key, value) {
	if ( typeof key !== 'string' )
		throw new TypeError('key must be a string');

	if ( typeof value !== 'number' )
		throw new TypeError('value must be a number');

	this.dataware_sort[key] = value;
	this._update();
}

/**
 * Use the given middleware for a named route parameter. Useful for automatically
 * loading data or performing validation.
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
		pws.push(fn);

	this._update();
}

/**
 * Mount the given middleware at a specific path. This will register the
 * middleware for all HTTP methods on the given route, and strip the path
 * from `ctx.path` temporarilly when calling the middleware.
 *
 * Internally, this is like setting a `{mount: '*'}` option on a route
 * and putting `/*` on the end of the path.
 * @param {String|String[]} path The path to mount the middleware at.
 * @param {Object} [options] An optional set of options for the middleware.
 * @param {...Function} middleware The middleware function(s) to use
 */
Router.prototype.mount = function(path, options, ...middleware) {
	if ( ! Array.isArray(path) )
		path = [path];

	if ( typeof options === 'function' ) {
		middleware.unshift(options);
		options = null;
	}

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
}


/**
 * Nest another @{link Router} as a child of this router, inheriting all of
 * its routes, middleware, etc.
 * @param {String|String[]} [path] The path to nest the router at.
 * @param {Router} router The router instance to be nested.
 */
Router.prototype.nest = function(path, router) {
	if ( path instanceof Router ) {
		router = path;
		path = null;
	}

	this._nest(path, router);
	this._update();
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
 * @param {String} name The name of the route
 * @param {Object} [params] Parameters to place in the generated URL.
 * Required if the route takes parameters. Any parameter not consumed in the route
 * will be added as a query parameter.
 * @param {Object} [options] .
 * @param {Object} [options.query] Query parameters for the generated URL.
 * @returns {String} The generated URL.
 */
Router.prototype.urlFor = function(name, params = {}, options = {}) {
	if ( ! this._named[name] )
		throw new Error('No such named route');

	const [known_params, fn] = this._named[name],
		query = options.query = options.query || {};

	for(const [name, val] of Object.entries(params)) {
		if ( ! known_params.includes(name) )
			query[name] = val;
	}

	options.pathname = fn(params);
	return formatURL(options);
}


Router.Mount = Mount;
