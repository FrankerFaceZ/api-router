'use strict';
/**
 * @fileOverview An efficient middleware composer for Koa.
 * @module composer
 */

const reuse = require('reusify');

/**
 * Compose a method that will efficiently execute multiple middleware for
 * Koa. This makes use of the [reusify](https://www.npmjs.com/package/reusify)
 * module to avoid allocating excess objects and functions during runtime when
 * at all possible. As a result, memory churn should be reduced while V8 should
 * be able to properly optimize these methods.
 *
 * This can be used as a drop-in replacement for [koa-compose](https://github.com/koajs/compose).
 *
 * Objects can be supplied, describing middleware that should be filtered to only
 * run on specific paths. These objects should be structured as:
 * ```javascript
 * {
 *     "filtered": true,
 *     "rich": true,
 *     "test": /\/[a-z]{3}\//,
 *     "fn": MiddlewareFunction
 * }
 * ```
 *
 * If `rich` is true, `test` should be a compiled regular expression or some other
 * object that has a `.test(url)` method. If `rich` is false, `test` should be
 * a string to be compared via `url.startsWith(test)`.
 *
 * @example
 * app.use(compose(cors(), cache(), router.middleware()));
 *
 * @function
 * @name compose
 * @param {...Function|Object|Function[]|Object[]} input The various middleware
 * to compose together. This can consist of functions or arrays of functions. The
 * input may also be comprised of objects that describe middleware that should
 * be filtered to only run on specific paths.
 * @returns {Function} The composed middleware
 */
module.exports = function compose(...input) {
	const middlewares = [];

	for(const section of input) {
		if ( ! section )
			continue;

		for(const fn of Array.isArray(section) ? section : [section]) {
			if ( ! fn )
				continue;

			if ( typeof fn === 'function' )
				middlewares.push({
					filtered: false,
					fn
				});
			else if ( fn.fn )
				middlewares.push(fn);
			else
				throw new TypeError('invalid input to compose')
		}
	}

	const len = middlewares.length;

	function Composer() {
		this.i = null;
		this.context = null;
		this.next = null;

		const that = this,
			bound = [];

		this.run = function(i) {
			if ( i <= that.i )
				return Promise.reject(new Error('next() called multiple times'));

			const path = that.context.request.path;

			let fn;
			while(i <= len) {
				if ( i === len ) {
					fn = that.next;
					break;
				}

				const middleware = middlewares[i];
				if ( ! middleware.filtered ||
						(middleware.rich ?
							middleware.test.test(path) :
							path.startsWith(middleware.test)) ) {
					fn = middleware.fn;
					break;
				}

				i++;
			}

			this.i = i;

			if ( ! fn )
				return Promise.resolve();

			try {
				return Promise.resolve(fn(that.context, bound[i+1]));
			} catch(err) {
				return Promise.reject(err);
			}
		}

		// We want to bind our run function once for every middleware,
		// and once more after that to chain to the next() that the
		// compose middleware was itself called with.
		for(let i=0; i <= len; i++)
			bound.push(this.run.bind(this, i));
	}

	const pool = reuse(Composer);

	const ret = async function composed(context, next) {
		const inst = pool.get();

		inst.i = -1;
		inst.context = context;
		inst.next = next;

		try {
			return await inst.run(0)
		} finally {
			inst.context = null;
			inst.next = null;

			pool.release(inst);
		}
	}

	ret._middleware = middlewares;

	return ret;
}
