import { storage } from "@/src/utils/storage";

const API = `${process.env.EXPO_PUBLIC_BACKEND_URL || ""}/api`;
const TOKEN_KEY = "spendpulse-auth-token";

export type User = { id: string; username: string; email: string; role?: string };

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await storage.secureGet(TOKEN_KEY, null);
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) },
  });
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.detail || "Something went wrong");
  return body as T;
}

export async function signUp(username: string, email: string, password: string) {
  await request<User>("/auth/signup", { method: "POST", body: JSON.stringify({ username, email, password }) });
  return signIn(username, password);
}

export async function signIn(username: string, password: string) {
  const result = await request<{ access_token: string }>("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
  await storage.secureSet(TOKEN_KEY, result.access_token);
  return request<User>("/me");
}

export async function restoreSession() {
  const token = await storage.secureGet(TOKEN_KEY, null);
  if (!token) return null;
  try { return await request<User>("/me"); } catch { await storage.secureRemove(TOKEN_KEY); return null; }
}

export async function signOut() {
  try { await request("/auth/logout", { method: "POST" }); } finally { await storage.secureRemove(TOKEN_KEY); }
}

export async function forgotPassword(email: string) {
  return request<{ ok: boolean; message: string }>("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) });
}

export async function resetPassword(token: string, newPassword: string) {
  const result = await request<{ access_token: string }>("/auth/reset-password", { method: "POST", body: JSON.stringify({ token, new_password: newPassword }) });
  await storage.secureSet(TOKEN_KEY, result.access_token);
  return request<User>("/me");
}

export async function authorizedRequest<T>(path: string, init: RequestInit = {}) { return request<T>(path, init); }
