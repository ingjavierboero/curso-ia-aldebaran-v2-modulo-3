import type { Currency } from '../domain/money';
import { api } from './client';

export type ProductStatus = 'activo' | 'inactivo';

export interface Product {
  id: number;
  name: string;
  priceCents: number;
  currency: Currency;
  status: ProductStatus;
}

export interface ProductInput {
  name: string;
  priceCents: number;
  currency: Currency;
}

/** Producto asignado a un cliente. */
export interface AssignedProduct extends Product {
  /** Fecha de asignación, en ISO. */
  assignedAt: string;
}

export async function listProducts(filters: { status?: ProductStatus } = {}): Promise<Product[]> {
  const query = filters.status ? `?status=${filters.status}` : '';
  return (await api<{ products: Product[] }>('GET', `/products${query}`)).products;
}

export async function createProduct(input: ProductInput): Promise<Product> {
  return (await api<{ product: Product }>('POST', '/products', input)).product;
}

export async function updateProduct(id: number, input: ProductInput): Promise<Product> {
  return (await api<{ product: Product }>('PUT', `/products/${id}`, input)).product;
}

export async function setProductActive(id: number, active: boolean): Promise<Product> {
  const action = active ? 'reactivate' : 'deactivate';
  return (await api<{ product: Product }>('POST', `/products/${id}/${action}`)).product;
}

export async function listAssignedProducts(clientId: number): Promise<AssignedProduct[]> {
  return (await api<{ products: AssignedProduct[] }>('GET', `/clients/${clientId}/products`)).products;
}

export async function assignProducts(clientId: number, productIds: number[]): Promise<AssignedProduct[]> {
  return (
    await api<{ products: AssignedProduct[] }>('POST', `/clients/${clientId}/products`, { productIds })
  ).products;
}

export async function unassignProduct(clientId: number, productId: number): Promise<AssignedProduct[]> {
  return (
    await api<{ products: AssignedProduct[] }>('DELETE', `/clients/${clientId}/products/${productId}`)
  ).products;
}
