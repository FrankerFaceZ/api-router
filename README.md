@ffz/api-router
===============

Routing middleware for [Koa](https://koajs.com/).

* Express-style routing using `router.get()`, `router.post()`, etc.
* Named URL parameters
* Named routes with URL generation
* Responds to `OPTIONS` automatically.
* Generates `405 Method Not Allowed` responses automatically.
* Multiple routers
* Nestable routers

* Associate random data with a route
* Automatically add middleware to routes based on that data

* Pre-computes middleware chains for every route to minimize computation and allocations during runtime
* Uses [find-my-way](https://github.com/delvedor/find-my-way) internally for route matching for fast routing


## Install

```bash
$ npm install @ffz/api-router --save
```

## Basic Usage

```javascript
import Koa from 'koa';
import Router from '@ffz/api-router';

const app = new Koa();
const router = new Router();

app.use(router.middleware());

router.get('/', (ctx, next) => {
	ctx.body = "Hello, World!"
})

app.listen(3000);
```

## Tests

Run tests using `npm test`. Run tests with coverage information using `npm run test-cov`.

## Contributions and Support

Please submit all issues and pull requests to the [FrankerFaceZ/api-router](https://github.com/frankerfacez/api-router) repository.
