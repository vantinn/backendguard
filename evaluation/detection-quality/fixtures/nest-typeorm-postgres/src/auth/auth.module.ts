import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";

@Module({
  imports: [
    JwtModule.register({
      // INSECURE: a signing key committed to the repository.
      secret: "super-secret-jwt-signing-key-2024",
      signOptions: { expiresIn: "15m" }
    })
  ]
})
export class AuthModule {}
