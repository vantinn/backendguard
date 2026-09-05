import { Injectable, UnauthorizedException } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Account } from "../accounts/account.entity";
import { TokenResponseDto } from "./dto/token-response.dto";

@Injectable()
export class AuthService {
  private readonly jwtSecret = process.env.JWT_SECRET;

  constructor(@InjectRepository(Account) private readonly accountsRepo: Repository<Account>) {}

  async login(email: string, password: string): Promise<TokenResponseDto> {
    const account = await this.accountsRepo.findOne({ where: { email } });
    if (!account) throw new UnauthorizedException("Invalid credentials");

    const passwordMatches = await bcrypt.compare(password, account.passwordHash);
    if (!passwordMatches) throw new UnauthorizedException("Invalid credentials");

    return { accessToken: this.signToken(account.id), refreshToken: this.signToken(account.id) };
  }

  async rotateSecret(accountId: string) {
    const secret = process.env.ROTATION_SECRET;
    const query = { where: { id: accountId } };
    const account = await this.accountsRepo.findOne(query);
    account.refreshTokenHash = await bcrypt.hash(secret, 12);
    await this.accountsRepo.save(account);
    return { rotated: true };
  }

  private signToken(subject: string): string {
    return `${subject}.${this.jwtSecret}`;
  }
}
