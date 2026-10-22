const assert = require('node:assert/strict');
const { test } = require('node:test');
const { findMethods, findRoutes, kindOf, convert, parseParams } = require('../out/parse.js');

test('findMethods detects service methods with @Injectable() and @Injectable', () => {
  const code = `
    @Injectable()
    export class ItemService {
      findAll(): Item[] { return []; }
      async findOne(id: string): Promise<Item> { return {} as any; }
      create<T extends ItemDto>(data: T, count: number = 1): Promise<T> { return Promise.resolve(data); }
      static helper() { return 42; }
    }

    @Injectable
    export class OtherService {
      execute(input: { flag: boolean } | null): void {}
    }
  `;
  const methods = findMethods(code);
  assert.equal(methods.length, 4);

  assert.equal(methods[0].className, 'ItemService');
  assert.equal(methods[0].method, 'findAll');
  assert.equal(methods[0].params.length, 0);

  assert.equal(methods[1].method, 'findOne');
  assert.equal(methods[1].params[0].name, 'id');
  assert.equal(methods[1].params[0].type, 'string');

  assert.equal(methods[2].method, 'create');
  assert.equal(methods[2].params[0].name, 'data');
  assert.equal(methods[2].params[0].type, 'T');

  assert.equal(methods[3].className, 'OtherService');
  assert.equal(methods[3].method, 'execute');
  assert.equal(methods[3].params[0].type, '{ flag: boolean } | null');
});

test('findRoutes detects all Nest HTTP methods and controller paths', () => {
  const code = `
    @Controller('api/v1/items')
    export class ItemController {
      @Get()
      list() {}

      @Get(':id')
      getOne(@Param('id') id: string) {}

      @Post('new')
      create(@Body() dto: CreateItemDto) {}

      @Put(':id')
      replace(@Param('id') id: string, @Body() dto: UpdateItemDto) {}

      @Patch(':id')
      update(@Param('id') id: string, @Body() dto: PartialItemDto) {}

      @Delete(':id')
      remove(@Param('id') id: string) {}

      @Head('status')
      checkStatus() {}

      @Options('info')
      optionsInfo() {}

      @All('catchall')
      all() {}

      @Get(computedRoute)
      dynamicRoute() {}
    }

    @Controller({ path: 'auth' })
    export class AuthController {
      @Post
      login(@Body() creds: LoginDto) {}
    }
  `;

  const routes = findRoutes(code);
  // dynamicRoute must be excluded
  assert.equal(routes.length, 10);

  const itemRoutes = routes.filter((r) => r.className === 'ItemController');
  assert.equal(itemRoutes.length, 9);
  assert.deepEqual(
    itemRoutes.map((r) => [r.httpMethod, r.routePath]),
    [
      ['GET', 'api/v1/items'],
      ['GET', 'api/v1/items/:id'],
      ['POST', 'api/v1/items/new'],
      ['PUT', 'api/v1/items/:id'],
      ['PATCH', 'api/v1/items/:id'],
      ['DELETE', 'api/v1/items/:id'],
      ['HEAD', 'api/v1/items/status'],
      ['OPTIONS', 'api/v1/items/info'],
      ['ALL', 'api/v1/items/catchall'],
    ],
  );

  const authRoutes = routes.filter((r) => r.className === 'AuthController');
  assert.equal(authRoutes.length, 1);
  assert.equal(authRoutes[0].httpMethod, 'POST');
  assert.equal(authRoutes[0].routePath, 'auth');
  assert.equal(authRoutes[0].hasBody, true);
  assert.equal(authRoutes[0].bodyType, 'LoginDto');
});

test('kindOf and convert correctly map TypeScript types to form representations', () => {
  assert.equal(kindOf('string'), 'text');
  assert.equal(kindOf('number'), 'number');
  assert.equal(kindOf('boolean'), 'boolean');
  assert.equal(kindOf('CreateUserDto'), 'json');
  assert.equal(kindOf('string[]'), 'json');
  assert.equal(kindOf('any'), 'any');
  assert.equal(kindOf('unknown'), 'any');

  assert.equal(convert('123', 'number'), 123);
  assert.equal(convert('', 'number'), undefined);
  assert.equal(convert('true', 'boolean'), true);
  assert.equal(convert('false', 'boolean'), false);
  assert.deepEqual(convert('{"name":"Ada"}', 'json'), { name: 'Ada' });
  assert.equal(convert('plain text', 'text'), 'plain text');
});

test('parseParams handles parameter modifiers and union types', () => {
  const raw = 'readonly id: string, public active: boolean, optional?: number, user: User | null';
  const parsed = parseParams(raw);
  assert.equal(parsed.length, 4);
  assert.equal(parsed[0].name, 'id');
  assert.equal(parsed[0].type, 'string');
  assert.equal(parsed[1].name, 'active');
  assert.equal(parsed[1].type, 'boolean');
  assert.equal(parsed[2].name, 'optional');
  assert.equal(parsed[2].type, 'number');
  assert.equal(parsed[3].name, 'user');
  assert.equal(parsed[3].type, 'User | null');
});
