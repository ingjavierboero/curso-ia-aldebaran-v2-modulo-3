export type UserRole = 'admin' | 'editor' | 'consulta';

export interface User {
  id: number;
  name: string;
  email: string;
  role: UserRole;
}

export interface AppInfo {
  mockMode: boolean;
  needsSetup: boolean;
}

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Admin',
  editor: 'Editor',
  consulta: 'Consulta',
};
