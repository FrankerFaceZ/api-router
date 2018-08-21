'use strict';
/**
 * @fileOverview Mounting middleware for {@link Router}.
 * @module mount
 */

/**
 * Koa Middleware that replaces `ctx.path` with the value of
 * a matched route parameter before calling `next()` and that
 * restores `ctx.path` after the next middleware has finished
 * executing.
 *
 * This middleware is included as a data-aware middleware by
 * {@link Router} by default, unless disabled with an option.
 *
 * {@link Router#mount} uses this middleware by setting
 * `{mount: "*"}` data on the route and by making sure that
 * the path ends with a catch-all param named `*`.
 *
 * @example
 * router.mount('/test', ctx => {
 *     // ctx.path will not include the /test prefix
 * })
 *
 * @function
 * @name Mount
 * @param {String} param The named parameter to use for the new path.
 * @returns {Function} The mount middleware
 */
module.exports = function Mount(param) {
	return async function Mount(ctx, next) {
		const old_path = ctx.path;
		ctx.path = `/${ctx.params[param]}`;
		try {
			return await next();
		} finally {
			ctx.path = old_path;
		}
	}
}
