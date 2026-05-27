export type FrontendEnv = {
  VITE_DEFAULT_BASE_URL?: string;
  VITE_API_BASE_URL?: string;
};

export const FRONTEND_ENV: FrontendEnv = {
  VITE_DEFAULT_BASE_URL: import.meta.env.VITE_DEFAULT_BASE_URL as string | undefined,
  VITE_API_BASE_URL: import.meta.env.VITE_API_BASE_URL as string | undefined,
};
