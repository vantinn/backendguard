import { IsEmail, IsString, MinLength } from "class-validator";

// SECURE control: a properly validated DTO.
export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(12)
  password: string;
}
