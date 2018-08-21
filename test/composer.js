const Chai = require('chai');
const AsPromised = require('chai-as-promised');
const compose = require('../lib/composer');
const should = Chai.should();

Chai.use(AsPromised);

const NOOP = () => {};
const COUNTER = (ctx, next) => {
	ctx.i++;
	if ( next )
		return next();
}

const getContext = (path = '') => ({request: {path}, i: 0});

describe('composer', function() {
	it('should compose middleware', function() {
		const ret = compose(NOOP, NOOP);

		should.exist(ret);
		ret.should.be.a('function');
		should.exist(ret._middleware);
		ret._middleware.length.should.eql(2);
	});

	it('should compose arrays of middleware', function() {
		const ret = compose([NOOP], [NOOP]);

		should.exist(ret);
		ret.should.be.a('function');
		should.exist(ret._middleware);
		ret._middleware.length.should.eql(2);
	});

	it('should skip empty arrays', function() {
		const ret = compose(NOOP, [], [NOOP]);

		should.exist(ret);
		ret.should.be.a('function');
		should.exist(ret._middleware);
		ret._middleware.length.should.eql(2);
	});

	it('should skip null values', function() {
		const ret = compose(NOOP, null, [null, NOOP]);

		should.exist(ret);
		ret.should.be.a('function');
		should.exist(ret._middleware);
		ret._middleware.length.should.eql(2);
	});

	it('should accept filterable middleware', function() {
		const ret = compose(NOOP, {
			fn: NOOP
		});

		should.exist(ret);
		ret.should.be.a('function');
		should.exist(ret._middleware);
		ret._middleware.length.should.eql(2);
	});

	it('should not accept non-function middleware', function() {
		should.throw(() => compose(3, NOOP));
		should.throw(() => compose(NOOP, {}));
	});

	it('should run middleware', async function() {
		const ret = compose(COUNTER, COUNTER);

		const ctx = getContext();
		await ret(ctx, NOOP);

		ctx.i.should.eql(2);
	});

	it('should not require a next function', async function() {
		const ret = compose(COUNTER),
			ctx = getContext();

		await ret(ctx);
		ctx.i.should.eql(1);
	});

	it('should call the next function it gets', async function() {
		const ret = compose(COUNTER),
			ctx = getContext();

		await ret(ctx, COUNTER);
		ctx.i.should.eql(2);
	});

	it('should run matching middleware', async function() {
		const ret = compose(
			{filtered: true, test: '/test', fn: COUNTER},
			{filtered: true, test: '/bad', fn: COUNTER},
			{filtered: true, rich: true, test: /\/t.*/, fn: COUNTER},
			{filtered: true, rich: true, test: {test: () => false}, fn: COUNTER},
			COUNTER
		);

		const ctx = getContext('/test');
		await ret(ctx, NOOP);

		ctx.i.should.eql(3);
	});

	it('should not allow multiple calls to next()', function() {
		const BAD = (ctx, next) => {
			next();
			return next();
		}

		const ret = compose(COUNTER, BAD),
			ctx = getContext();

		return ret(ctx, NOOP).should.be.rejected;
	});

	it('should not swallow errors', function() {
		const BAD = () =>
			DOES_NOT_EXIST //eslint-disable-line no-undef

		const ret = compose(BAD),
			ctx = getContext();

		return ret(ctx).should.be.rejected;
	})
});
