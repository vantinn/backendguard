import { IsEmail, IsString, MinLength } from "class-validator";

export class CreateAccountDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(60)
  passwordHash: string;
}
