import { Account } from "../account.entity";

export class AccountResponseDto {
  id: string;
  email: string;

  static from(account: Account): AccountResponseDto {
    const dto = new AccountResponseDto();
    dto.id = account.id;
    dto.email = account.email;
    return dto;
  }
}
