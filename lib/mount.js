/**
 * Middleware Mounter for Router
 *
 * @author SirStendec <sir@stendec.me>
 * @link https://github.com/frankerfacez/api-router
 */

module.exports = Mount;

function Mount(param) {
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
