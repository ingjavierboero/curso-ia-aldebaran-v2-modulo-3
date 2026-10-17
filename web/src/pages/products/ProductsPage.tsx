import { EditOutlined, PlusOutlined, StopOutlined, UndoOutlined } from '@ant-design/icons';
import { App, Button, Segmented, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useState } from 'react';
import styled from 'styled-components';
import {
  createProduct,
  listProducts,
  setProductActive,
  updateProduct,
  type Product,
  type ProductInput,
  type ProductStatus,
} from '../../api/products';
import { TableAction } from '../../components/TableAction';
import { CURRENCY_LABELS, formatMoney } from '../../domain/money';
import { useCanEdit } from '../../stores/session';
import { ProductFormModal } from './ProductFormModal';

const Toolbar = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  margin-bottom: 16px;
`;

type StatusFilter = ProductStatus | 'todos';

const STATUS_OPTIONS = [
  { value: 'todos', label: 'Todos' },
  { value: 'activo', label: 'Activos' },
  { value: 'inactivo', label: 'Inactivos' },
];

export function ProductsPage() {
  const canEdit = useCanEdit();
  const { message } = App.useApp();

  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<StatusFilter>('todos');
  const [editing, setEditing] = useState<Product | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setProducts(await listProducts({ status: status === 'todos' ? undefined : status }));
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'No se pudieron cargar los productos.');
    } finally {
      setLoading(false);
    }
  }, [status, message]);

  useEffect(() => {
    void load();
  }, [load]);

  function openForm(product: Product | null) {
    setEditing(product);
    setFormOpen(true);
  }

  async function handleSubmit(input: ProductInput) {
    if (editing) {
      await updateProduct(editing.id, input);
      message.success('Producto modificado.');
    } else {
      await createProduct(input);
      message.success('Producto dado de alta.');
    }
    setFormOpen(false);
    await load();
  }

  async function toggleActive(product: Product) {
    const activate = product.status === 'inactivo';
    try {
      await setProductActive(product.id, activate);
      message.success(activate ? 'Producto reactivado.' : 'Producto desactivado.');
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'No se pudo cambiar el estado.');
    }
  }

  const columns: ColumnsType<Product> = [
    { title: 'Nombre', dataIndex: 'name' },
    {
      title: 'Precio de la cuota',
      dataIndex: 'priceCents',
      align: 'right',
      render: (cents: number, product) => formatMoney(cents, product.currency),
    },
    { title: 'Moneda', dataIndex: 'currency', render: (c: Product['currency']) => CURRENCY_LABELS[c] },
    {
      title: 'Estado',
      dataIndex: 'status',
      render: (value: ProductStatus) =>
        value === 'activo' ? <Tag color="green">Activo</Tag> : <Tag>Inactivo</Tag>,
    },
  ];

  if (canEdit) {
    columns.push({
      title: 'Acciones',
      key: 'actions',
      align: 'center',
      width: 100,
      render: (_, product) => {
        const active = product.status === 'activo';
        return (
          <Space size={4}>
            <TableAction label="Modificar" icon={<EditOutlined />} onClick={() => openForm(product)} />
            <TableAction
              label={active ? 'Desactivar' : 'Reactivar'}
              icon={active ? <StopOutlined /> : <UndoOutlined />}
              danger={active}
              confirm={
                active
                  ? '¿Desactivar este producto? Deja de facturarse a los clientes que lo tienen asignado.'
                  : '¿Reactivar este producto?'
              }
              onClick={() => toggleActive(product)}
            />
          </Space>
        );
      },
    });
  }

  return (
    <>
      <Typography.Title level={3}>Productos</Typography.Title>
      <Toolbar>
        <Segmented options={STATUS_OPTIONS} value={status} onChange={(v) => setStatus(v as StatusFilter)} />
        {canEdit && (
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => openForm(null)}
            style={{ marginInlineStart: 'auto' }}
          >
            Nuevo producto
          </Button>
        )}
      </Toolbar>
      <Table
        rowKey="id"
        columns={columns}
        dataSource={products}
        loading={loading}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        locale={{ emptyText: status !== 'todos' ? 'Ningún producto coincide con el filtro.' : 'Todavía no hay productos.' }}
        scroll={{ x: true }}
      />
      <ProductFormModal
        open={formOpen}
        product={editing}
        onSubmit={handleSubmit}
        onClose={() => setFormOpen(false)}
      />
    </>
  );
}
