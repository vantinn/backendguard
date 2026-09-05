import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { Account } from "./account.entity";
import { AccountResponseDto } from "./dto/account-response.dto";
import { CreateAccountDto } from "./dto/create-account.dto";

@Injectable()
export class AccountsService {
  constructor(
    @InjectRepository(Account) private readonly accountsRepo: Repository<Account>,
    private readonly dataSource: DataSource
  ) {}

  async list(page: number): Promise<AccountResponseDto[]> {
    const rows = await this.accountsRepo.find({ take: 25, skip: page * 25 });
    return rows.map((row) => AccountResponseDto.from(row));
  }

  async create(dto: CreateAccountDto): Promise<AccountResponseDto> {
    return this.dataSource.transaction(async (manager) => {
      const account = manager.create(Account, { email: dto.email, passwordHash: dto.passwordHash });
      await manager.save(account);
      await manager.save(Account, { ...account, refreshTokenHash: null });
      return AccountResponseDto.from(account);
    });
  }

  async findByIds(ids: string[]): Promise<Account[]> {
    // Batched lookup, deliberately not a per-id query in a loop.
    return this.accountsRepo.find({ where: ids.map((id) => ({ id })), take: 100 });
  }
}
