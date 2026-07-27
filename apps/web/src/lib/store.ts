import { create } from "zustand";
import { fetchApi } from "./api";

export interface User {
  id: string;
  username: string;
  role: "admin" | "user";
}

interface AuthState {
  user: User | null;
  loading: boolean;
  checkAuth: () => Promise<void>;
  logout: () => void;
  setUser: (user: User) => void;
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  loading: true,
  setUser: (user) => set({ user }),
  checkAuth: async () => {
    try {
      const data = await fetchApi("/auth/me");
      set({ user: data as User, loading: false });
    } catch (err) {
      set({ user: null, loading: false });
    }
  },
  logout: async () => {
    localStorage.removeItem("token");
    try {
      await fetchApi("/auth/logout", { method: "POST", body: "{}" });
    } catch {
      // ignored
    }
    set({ user: null });
    window.location.href = "/login";
  },
}));
