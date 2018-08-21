# @ffz/api-router

[![NPM Version](https://img.shields.io/npm/v/@ffz/api-router.svg?style=flat)](https://npmjs.org/package/@ffz/api-router)
![Node Version](https://img.shields.io/node/v/@ffz/api-router.svg?style=flat)
[![Dependency Status](https://img.shields.io/circleci/project/github/FrankerFaceZ/api-router.svg?style=flat)](https://circleci.com/gh/frankerfacez/api-router)
[![Build Status](https://img.shields.io/david/frankerfacez/api-router.svg?style=flat)](https://david-dm.org/frankerfacez/api-router)
[![Test Coverage](https://coveralls.io/repos/github/FrankerFaceZ/api-router/badge.svg?branch=master)](https://coveralls.io/github/FrankerFaceZ/api-router?branch=master)

Routing middleware for [Koa](https://koajs.com/).

-   Express-style routing using `router.get()`, `router.post()`, etc.
-   Named URL parameters
-   Named routes with URL generation
-   Responds to `OPTIONS` automatically.
-   Generates `405 Method Not Allowed` responses automatically.
-   Multiple routers
-   Nestable routers
-   Associate random data with a route
-   Automatically add middleware to routes based on that data
-   Pre-computes middleware chains for every route to minimize computation and allocations during runtime
-   Uses [find-my-way](https://github.com/delvedor/find-my-way) internally for route matching for fast routing

* * *

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

## More Interesting Usage

```javascript
import Koa from 'koa';
import Router from '@ffz/api-router';

import redis from './redis_stuff';
import generate_random_id from './some_other_place';

const app = new Koa();
const router = new Router();

router.useData('cache', options => {
    const duration = options.duration || 120;

    return (ctx, next) => {
        const key = ctx.url,
            cached = await redis.hgetall(key);

        if ( cached && cached.status ) {
            ctx.status = parseInt(cached.status, 10);
            ctx.etag = cached.etag;

            if ( ctx.fresh ) {
                ctx.status = 304;
            } else {
                ctx.type = cached.type;
                ctx.body = cached.body;
            }

            return;
        }

        await next();

        const etag = generate_random_id();
        ctx.etag = etag;

        const body = typeof ctx.body === 'string' ?
            ctx.body :
            JSON.stringify(ctx.body);

        await redis.multi().hmset(key, {
            status: ctx.status,
            type: ctx.type,
            etag,
            body
        }).expire(key, duration).exec();
    }
});

router.get('/', {cache: {duration: 60}}, (ctx, next) => {
    ctx.body = "Hello, World!"
})

app.use(router.middleware());
app.listen(3000);
```

The above code sets up a very simple caching middleware using Redis.
The middleware is registered for `cache` data. Then, we register a
new route and the route has `cache` data, so that middleware is
automatically applied to it.

## Tests

Run tests using `npm test`.

## Contributions and Support

Please submit all issues and pull requests to the [FrankerFaceZ/api-router](https://github.com/frankerfacez/api-router) repository.
