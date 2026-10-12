
import { randomBytes } from "node:crypto";
import { google } from "googleapis";

import { config } from "./config.js";
import { supabase } from "./services/supabase.js";

const SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
];

const OAUTH_STATE_TTL_MINUTES = 10;

export function getOAuthClient() {
  return new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret,
    config.googleRedirectUri,
  );
}

/**
 * Gera uma URL de autorização vinculada ao usuário autenticado.
 */
export async function getGoogleAuthUrl(userId: string) {
  const state = randomBytes(32).toString("hex");

  const expiresAt = new Date(
    Date.now() + OAUTH_STATE_TTL_MINUTES * 60 * 1000,
  ).toISOString();

  const { error } = await supabase
    .from("google_oauth_states")
    .insert({
      state,
      user_id: userId,
      expires_at: expiresAt,
    });

  if (error) {
    throw new Error("Não foi possível iniciar a conexão com o Google.");
  }

  const client = getOAuthClient();

  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
  });
}

/**
 * Valida o state e salva o refresh token do usuário correspondente.
 */
export async function exchangeCode(code: string, state: string) {
  const now = new Date().toISOString();

  // Consome o state uma única vez, se ainda estiver válido.
  const { data: oauthState, error: stateError } = await supabase
    .from("google_oauth_states")
    .delete()
    .eq("state", state)
    .gt("expires_at", now)
    .select("user_id")
    .maybeSingle();

  if (stateError || !oauthState) {
    throw new Error("Estado OAuth inválido ou expirado.");
  }

  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);

  // Uma nova autorização pode não retornar outro refresh token.
  const { data: existing, error: existingError } = await supabase
    .from("google_connections")
    .select("refresh_token")
    .eq("user_id", oauthState.user_id)
    .maybeSingle();

  if (existingError) {
    throw new Error("Não foi possível consultar a conexão existente.");
  }

  const refreshToken =
    tokens.refresh_token ?? existing?.refresh_token;

  if (!refreshToken) {
    throw new Error(
      "O Google não retornou um refresh token. Tente autorizar novamente.",
    );
  }

  const { error: saveError } = await supabase
    .from("google_connections")
    .upsert(
      {
        user_id: oauthState.user_id,
        refresh_token: refreshToken,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );

  if (saveError) {
    throw new Error("Não foi possível salvar a conexão com o Google.");
  }
}

/**
 * Cria um cliente do Drive usando a conexão do proprietário informado.
 */
export async function getDrive(userId: string) {
  const { data: connection, error } = await supabase
    .from("google_connections")
    .select("refresh_token")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error("Não foi possível consultar a conexão com o Google.");
  }

  if (!connection?.refresh_token) {
    throw new Error("GOOGLE_NOT_CONNECTED");
  }

  const auth = getOAuthClient();

  auth.setCredentials({
    refresh_token: connection.refresh_token,
  });

  // Se o Google devolver um refresh token novo, atualiza o registro.
  auth.on("tokens", async (tokens) => {
    if (!tokens.refresh_token) return;

    const { error: updateError } = await supabase
      .from("google_connections")
      .update({
        refresh_token: tokens.refresh_token,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);

    if (updateError) {
      console.error("Não foi possível atualizar o refresh token.");
    }
  });

  return google.drive({
    version: "v3",
    auth,
  });
}
