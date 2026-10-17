import { api } from './client';

export type ClientStatus = 'activo' | 'inactivo';

/** RF-38: condiciones frente al IVA admitidas para el receptor de una Factura C. */
export const IVA_CONDITIONS: Record<number, string> = {
  1: 'IVA Responsable Inscripto',
  4: 'IVA Sujeto Exento',
  5: 'Consumidor Final',
  6: 'Responsable Monotributo',
  7: 'Sujeto No Categorizado',
  8: 'Proveedor del Exterior',
  9: 'Cliente del Exterior',
  10: 'IVA Liberado – Ley N° 19.640',
  13: 'Monotributista Social',
  15: 'IVA No Alcanzado',
  16: 'Monotributo Trabajador Independiente Promovido',
};

export interface Client {
  id: number;
  businessName: string;
  cuit: string;
  /** null solo en clientes cargados antes de que existiera el dato. */
  address: string | null;
  billingEmail: string;
  ivaCondition: number | null;
  status: ClientStatus;
  /** Fecha de alta, en ISO. */
  createdAt: string;
}

export interface ClientInput {
  businessName: string;
  cuit: string;
  address: string;
  billingEmail: string;
  ivaCondition: number;
}

export async function listClients(filters: { status?: ClientStatus; q?: string }): Promise<Client[]> {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.q) params.set('q', filters.q);
  const query = params.size > 0 ? `?${params}` : '';
  return (await api<{ clients: Client[] }>('GET', `/clients${query}`)).clients;
}

export async function getClient(id: number): Promise<Client> {
  return (await api<{ client: Client }>('GET', `/clients/${id}`)).client;
}

export async function createClient(input: ClientInput): Promise<Client> {
  return (await api<{ client: Client }>('POST', '/clients', input)).client;
}

export async function updateClient(id: number, input: ClientInput): Promise<Client> {
  return (await api<{ client: Client }>('PUT', `/clients/${id}`, input)).client;
}

export async function setClientActive(id: number, active: boolean): Promise<Client> {
  const action = active ? 'reactivate' : 'deactivate';
  return (await api<{ client: Client }>('POST', `/clients/${id}/${action}`)).client;
}
