import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeProjectSource } from "../analysis/security/nestjs-security-analyzer.js";

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "backendguard-ast-"));
}

function writeFiles(repo, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(repo, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
}

function findingsOf(findings, id) {
  return findings.filter((f) => f.id === id);
}

describe("nestjs security analyzer: SEC-001 sensitive entity exposure", () => {
  it("flags a controller returning a repo-resolved entity with sensitive columns, with no DTO mapping", () => {
    const repo = makeRepo();
    writeFiles(repo, {
      "src/users/user.entity.ts": `
        @Entity()
        export class User {
          @PrimaryGeneratedColumn() id: string;
          @Column() email: string;
          @Column() passwordHash: string;
        }
      `,
      "src/users/users.service.ts": `
        @Injectable()
        export class UsersService {
          constructor(@InjectRepository(User) private readonly usersRepo: Repository<User>) {}
          async findById(id: string) { return this.usersRepo.findOne({ where: { id } }); }
        }
      `,
      "src/users/users.controller.ts": `
        @Controller('users')
        export class UsersController {
          constructor(private readonly usersService: UsersService) {}
          @UseGuards(JwtAuthGuard)
          @Get(':id')
          async getById(@Param('id') id: string) {
            return this.usersService.findById(id);
          }
        }
      `
    });

    const findings = findingsOf(analyzeProjectSource({ cwd: repo }), "SEC-001");
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe("src/users/users.controller.ts");
    expect(findings[0].detail).toContain("passwordHash");
  });

  it("flags an entity leak even when the repo result flows through a local variable first (fetch, null-check, return)", () => {
    const repo = makeRepo();
    writeFiles(repo, {
      "src/users/user.entity.ts": `
        @Entity()
        export class User {
          @Column() email: string;
          @Column() passwordHash: string;
        }
      `,
      "src/users/users.service.ts": `
        @Injectable()
        export class UsersService {
          constructor(@InjectRepository(User) private readonly usersRepo: Repository<User>) {}
          async findById(id: string): Promise<User> {
            const user = await this.usersRepo.findOne({ where: { id } });
            if (!user) { throw new NotFoundException('User not found'); }
            return user;
          }
        }
      `,
      "src/users/users.controller.ts": `
        @Controller('users')
        export class UsersController {
          constructor(private readonly usersService: UsersService) {}
          @UseGuards(JwtAuthGuard)
          @Get(':id')
          async getById(@Param('id') id: string) {
            return this.usersService.findById(id);
          }
        }
      `
    });

    const findings = findingsOf(analyzeProjectSource({ cwd: repo }), "SEC-001");
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe("src/users/users.controller.ts");
  });

  it("does not flag a controller that maps the entity to a *Dto before returning it", () => {
    const repo = makeRepo();
    writeFiles(repo, {
      "src/users/user.entity.ts": `
        @Entity()
        export class User {
          @Column() email: string;
          @Column() passwordHash: string;
        }
      `,
      "src/users/users.service.ts": `
        @Injectable()
        export class UsersService {
          constructor(@InjectRepository(User) private readonly usersRepo: Repository<User>) {}
          async findById(id: string) { return this.usersRepo.findOne({ where: { id } }); }
        }
      `,
      "src/users/users.controller.ts": `
        @Controller('users')
        export class UsersController {
          constructor(private readonly usersService: UsersService) {}
          @UseGuards(JwtAuthGuard)
          @Get(':id')
          async getById(@Param('id') id: string): Promise<UserResponseDto> {
            const user = await this.usersService.findById(id);
            return UserResponseDto.fromEntity(user);
          }
        }
      `
    });

    expect(findingsOf(analyzeProjectSource({ cwd: repo }), "SEC-001")).toHaveLength(0);
  });

  it("does not flag an entity with no sensitive columns", () => {
    const repo = makeRepo();
    writeFiles(repo, {
      "src/products/product.entity.ts": `
        @Entity()
        export class Product {
          @Column() name: string;
          @Column() priceCents: number;
        }
      `,
      "src/products/products.service.ts": `
        @Injectable()
        export class ProductsService {
          constructor(@InjectRepository(Product) private readonly productsRepo: Repository<Product>) {}
          async findById(id: string) { return this.productsRepo.findOne({ where: { id } }); }
        }
      `,
      "src/products/products.controller.ts": `
        @Controller('products')
        export class ProductsController {
          constructor(private readonly productsService: ProductsService) {}
          @Get(':id')
          async getById(@Param('id') id: string) {
            return this.productsService.findById(id);
          }
        }
      `
    });

    expect(findingsOf(analyzeProjectSource({ cwd: repo }), "SEC-001")).toHaveLength(0);
  });
});

describe("nestjs security analyzer: SEC-002 missing guard", () => {
  it("flags a state-changing route with no guard at HIGH severity", () => {
    const repo = makeRepo();
    writeFiles(repo, {
      "src/payments/payments.controller.ts": `
        @Controller('payments')
        export class PaymentsController {
          constructor(private readonly paymentsService: PaymentsService) {}
          @Post()
          async pay(@Body() dto: CreatePaymentDto) { return this.paymentsService.pay(dto); }
        }
      `
    });
    const findings = findingsOf(analyzeProjectSource({ cwd: repo }), "SEC-002");
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("HIGH");
  });

  it("downgrades an unguarded GET to MEDIUM instead of suppressing it", () => {
    const repo = makeRepo();
    writeFiles(repo, {
      "src/products/products.controller.ts": `
        @Controller('products')
        export class ProductsController {
          constructor(private readonly productsService: ProductsService) {}
          @Get()
          async findAll() { return this.productsService.findAll(); }
        }
      `
    });
    const findings = findingsOf(analyzeProjectSource({ cwd: repo }), "SEC-002");
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("MEDIUM");
  });

  it("does not flag a guarded route (class-level or method-level)", () => {
    const repo = makeRepo();
    writeFiles(repo, {
      "src/orders/orders.controller.ts": `
        @UseGuards(JwtAuthGuard)
        @Controller('orders')
        export class OrdersController {
          constructor(private readonly ordersService: OrdersService) {}
          @Get(':id')
          async findOne(@Param('id') id: string) { return this.ordersService.findById(id); }
        }
      `,
      "src/notifications/notifications.controller.ts": `
        @Controller('notifications')
        export class NotificationsController {
          constructor(private readonly notificationsService: NotificationsService) {}
          @UseGuards(JwtAuthGuard)
          @Post()
          async create(@Body() dto: CreateNotificationDto) { return this.notificationsService.create(dto); }
        }
      `
    });
    expect(findingsOf(analyzeProjectSource({ cwd: repo }), "SEC-002")).toHaveLength(0);
  });

  it("does not flag conventionally public auth routes (login/register)", () => {
    const repo = makeRepo();
    writeFiles(repo, {
      "src/auth/auth.controller.ts": `
        @Controller('auth')
        export class AuthController {
          constructor(private readonly authService: AuthService) {}
          @Post('login')
          async login(@Body() dto: LoginDto) { return this.authService.login(dto); }
          @Post('register')
          async register(@Body() dto: RegisterDto) { return this.authService.register(dto); }
        }
      `
    });
    expect(findingsOf(analyzeProjectSource({ cwd: repo }), "SEC-002")).toHaveLength(0);
  });
});

describe("nestjs security analyzer: SEC-003 hardcoded secret", () => {
  it("flags a plain string literal assigned to a secret-shaped property", () => {
    const repo = makeRepo();
    writeFiles(repo, {
      "src/auth/jwt.strategy.ts": `
        export class JwtStrategy extends PassportStrategy(Strategy) {
          constructor() {
            super({ jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(), secretOrKey: 'supersecret123' });
          }
        }
      `
    });
    const findings = findingsOf(analyzeProjectSource({ cwd: repo }), "SEC-003");
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe("src/auth/jwt.strategy.ts");
  });

  it("does not flag a secret read from process.env", () => {
    const repo = makeRepo();
    writeFiles(repo, {
      "src/auth/jwt.strategy.ts": `
        export class JwtStrategy extends PassportStrategy(Strategy) {
          constructor() {
            super({ jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(), secretOrKey: process.env.JWT_SECRET });
          }
        }
      `
    });
    expect(findingsOf(analyzeProjectSource({ cwd: repo }), "SEC-003")).toHaveLength(0);
  });
});

describe("nestjs security analyzer: SEC-004 unvalidated body", () => {
  it("flags @Body() typed any", () => {
    const repo = makeRepo();
    writeFiles(repo, {
      "src/users/users.controller.ts": `
        @Controller('users')
        export class UsersController {
          constructor(private readonly usersService: UsersService) {}
          @Post()
          async create(@Body() body: any) { return this.usersService.create(body); }
        }
      `
    });
    const findings = findingsOf(analyzeProjectSource({ cwd: repo }), "SEC-004");
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toMatch(/no DTO type/);
  });

  it("flags a DTO with zero class-validator decorators", () => {
    const repo = makeRepo();
    writeFiles(repo, {
      "src/users/dto/create-user.dto.ts": `
        export class CreateUserDto {
          email: string;
          password: string;
        }
      `,
      "src/users/users.controller.ts": `
        @Controller('users')
        export class UsersController {
          constructor(private readonly usersService: UsersService) {}
          @Post()
          async create(@Body() dto: CreateUserDto) { return this.usersService.create(dto); }
        }
      `
    });
    const findings = findingsOf(analyzeProjectSource({ cwd: repo }), "SEC-004");
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toMatch(/no class-validator decorators/);
  });

  it("does not flag a DTO whose properties carry class-validator decorators", () => {
    const repo = makeRepo();
    writeFiles(repo, {
      "src/users/dto/create-user.dto.ts": `
        export class CreateUserDto {
          @IsEmail() email: string;
          @IsString() @MinLength(8) password: string;
        }
      `,
      "src/users/users.controller.ts": `
        @Controller('users')
        export class UsersController {
          constructor(private readonly usersService: UsersService) {}
          @Post()
          async create(@Body() dto: CreateUserDto) { return this.usersService.create(dto); }
        }
      `
    });
    expect(findingsOf(analyzeProjectSource({ cwd: repo }), "SEC-004")).toHaveLength(0);
  });
});

describe("nestjs security analyzer: SEC-005 raw error exposure", () => {
  it("flags a catch block that builds err.stack/err.message into a response object literal", () => {
    const repo = makeRepo();
    writeFiles(repo, {
      "src/payments/payments.controller.ts": `
        @Controller('payments')
        export class PaymentsController {
          @Post()
          async pay() {
            try {
              return await this.paymentsService.pay();
            } catch (err) {
              throw { statusCode: 500, message: err.message, stack: err.stack };
            }
          }
        }
      `
    });
    const findings = findingsOf(analyzeProjectSource({ cwd: repo }), "SEC-005");
    expect(findings.length).toBeGreaterThanOrEqual(2);
  });

  it("does not flag a catch block that only logs the error server-side", () => {
    const repo = makeRepo();
    writeFiles(repo, {
      "src/payments/payments.controller.ts": `
        @Controller('payments')
        export class PaymentsController {
          @Post()
          async pay() {
            try {
              return await this.paymentsService.pay();
            } catch (err) {
              this.logger.error(err.message, err.stack);
              throw new InternalServerErrorException('Something went wrong');
            }
          }
        }
      `
    });
    expect(findingsOf(analyzeProjectSource({ cwd: repo }), "SEC-005")).toHaveLength(0);
  });
});

describe("nestjs security analyzer: false-positive control", () => {
  it("produces zero findings for a fully secure module using the words password/token/query in benign ways", () => {
    const repo = makeRepo();
    writeFiles(repo, {
      "src/secure/api-key.entity.ts": `
        @Entity()
        export class ApiKey {
          @Column() label: string;
          @Column() tokenHash: string;
        }
      `,
      "src/secure/dto/create-api-key.dto.ts": `
        export class CreateApiKeyDto {
          @IsString() @MinLength(3) label: string;
        }
      `,
      "src/secure/dto/api-key-response.dto.ts": `
        export class ApiKeyResponseDto {
          id: string;
          label: string;
          static fromEntity(entity) {
            const dto = new ApiKeyResponseDto();
            dto.id = entity.id;
            dto.label = entity.label;
            return dto;
          }
        }
      `,
      "src/secure/secure.service.ts": `
        @Injectable()
        export class SecureService {
          constructor(@InjectRepository(ApiKey) private readonly apiKeyRepo: Repository<ApiKey>) {}
          async list(userId: string, query: { take: number; skip: number }) {
            return this.apiKeyRepo.find({ where: { userId }, take: query.take, skip: query.skip });
          }
          async create(userId: string, dto: CreateApiKeyDto) {
            return this.apiKeyRepo.save(this.apiKeyRepo.create({ userId, label: dto.label }));
          }
        }
      `,
      "src/secure/secure.controller.ts": `
        @UseGuards(JwtAuthGuard)
        @Controller('api-keys')
        export class SecureController {
          constructor(private readonly secureService: SecureService) {}
          @Post()
          async create(@Body() dto: CreateApiKeyDto, @Req() req: any) {
            const entity = await this.secureService.create(req.user.userId, dto);
            return ApiKeyResponseDto.fromEntity(entity);
          }
          @Get()
          async list(@Query() query: any, @Req() req: any) {
            const items = await this.secureService.list(req.user.userId, query);
            return items.map((item) => ApiKeyResponseDto.fromEntity(item));
          }
        }
      `,
      "src/auth/jwt.strategy.ts": `
        export class JwtStrategy {
          constructor(config: ConfigService) {
            super({ secretOrKey: config.get('JWT_SECRET') });
          }
        }
      `
    });

    const findings = analyzeProjectSource({ cwd: repo });
    expect(findings).toHaveLength(0);
  });
});
