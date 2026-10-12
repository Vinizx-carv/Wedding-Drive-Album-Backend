import "dotenv/config";


console.log({
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET ? "OK" : "NÃO CONFIGURADO",
  redirectUri: process.env.GOOGLE_REDIRECT_URI,
});
export const config = {
  port: Number(process.env.PORT ?? 4000),
  frontendUrl: process.env.FRONTEND_URL ?? "http://localhost:5173",
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  googleRedirectUri:
    process.env.GOOGLE_REDIRECT_URI ??
    "http://localhost:4000/auth/google/callback",
};

if (!config.googleClientId || !config.googleClientSecret) {
  console.warn(
    "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET não configurados. Configure o arquivo .env."
  );
}
