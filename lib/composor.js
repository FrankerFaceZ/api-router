/**
 * Middleware Composor for Router, using Reusify for performance.
 *
 * @author SirStendec <sir@stendec.me>
 * @link https://github.com/frankerfacez/api-router
 */

const reuse = require('reusify');

module.exports = compose;

function compose(...input) {
	const middlewares = [];

	for(const bit of input) {
		if ( ! bit )
			continue;

		for(const fn of Array.isArray(bit) ? bit : [bit]) {
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
				throw new Error('invalid input to compose')
		}
	}

	const len = middlewares.length;

	function Composor() {
		this.i = null;
		this.context = null;
		this.next = null;

		const that = this,
			bound = [];

		this.run = function(i) {
			if ( i <= that.i )
				return Promise.reject(new Error('next() called multiple times'));

			const url = that.context.req.url;

			let fn;
			while(i <= len) {
				if ( i === len ) {
					fn = that.next;
					break;
				}

				const middleware = middlewares[i];
				if ( ! middleware.filtered ||
						(middleware.rich ?
							middleware.test.test(url) :
							url.startsWith(middleware.test)) ) {
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

		for(let i=0; i <= len; i++)
			bound.push(this.run.bind(this, i));
	}

	const pool = reuse(Composor);

	const ret = async function (context, next) {
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
