import { Controller, Get, Post, Put, Sse, Options, Head } from '@nestjs/common';

/** Controller with object-form prefix and version meta */
@Controller({ path: 'products', version: '2' })
export class ProductsController {
    @Get()
    list() {
        return [];
    }

    @Post()
    create() {
        return {};
    }

    @Put(':id')
    replace() {
        return {};
    }

    @Sse('events')
    events() {
        return [];
    }

    @Options()
    options() {
        return {};
    }

    @Head(':id')
    check() {
        return {};
    }
}

/** No-arg controller (root prefix) */
@Controller()
export class HealthController {
    @Get('health')
    health() {
        return { ok: true };
    }
}
