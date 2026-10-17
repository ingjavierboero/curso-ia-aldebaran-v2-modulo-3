import { DisconnectOutlined, PlusOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Modal, Select, Table, Tag, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useState } from 'react';
import {
  assignProducts,
  listAssignedProducts,
  listProducts,
  unassignProduct,
  type AssignedProduct,
  type Product,
} from '../../api/products';
import { TableAction } from '../../components/TableAction';
import { formatMoney } from '../../domain/money';
import { useCanEdit } from '../../stores/session';

/** RF-49, RF-50: productos asignados al cliente, con asignación y desasignación. */
export function AssignedProductsCard({ clientId }: { clientId: number }) {
  const canEdit = useCanEdit();
  const { message } = App.useApp();
  const [assigned, setAssigned] = useState<AssignedProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setAssigned(await listAssignedProducts(clientId));
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'No se pudieron cargar los productos.');
    } finally {
      setLoading(false);
    }
  }, [clientId, message]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleUnassign(product: AssignedProduct) {
    try {
      setAssigned(await unassignProduct(clientId, product.id));
      message.success(`"${product.name}" desasignado.`);
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'No se pudo desasignar el producto.');
    }
  }

  const columns: ColumnsType<AssignedProduct> = [
    { title: 'Producto', dataIndex: 'name' },
    {
      title: 'Cuota mensual',
      dataIndex: 'priceCents',
      align: 'right',
      render: (cents: number, p) => formatMoney(cents, p.currency),
    },
    {
      title: 'Estado',
      dataIndex: 'status',
      render: (status: AssignedProduct['status']) =>
        status === 'activo' ? (
          <Tag color="green">Activo</Tag>
        ) : (
          <Tooltip title="Los productos Inactivos no se facturan.">
            <Tag>Inactivo</Tag>
          </Tooltip>
        ),
    },
  ];
  if (canEdit) {
    columns.push({
      title: 'Acciones',
      key: 'actions',
      align: 'center',
      width: 100,
      render: (_, product) => (
        <TableAction
          label="Desasignar"
          icon={<DisconnectOutlined />}
          danger
          confirm={`¿Desasignar "${product.name}" de este cliente?`}
          onClick={() => handleUnassign(product)}
        />
      ),
    });
  }

  return (
    <Card
      title="Productos asignados"
      extra={
        canEdit && (
          <Button icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
            Asignar productos
          </Button>
        )
      }
    >
      <Table
        rowKey="id"
        columns={columns}
        dataSource={assigned}
        loading={loading}
        pagination={false}
        size="small"
        locale={{ emptyText: 'No tiene productos asignados.' }}
      />
      <AssignProductsModal
        open={modalOpen}
        assignedIds={assigned.map((p) => p.id)}
        onClose={() => setModalOpen(false)}
        onAssign={async (ids) => {
          setAssigned(await assignProducts(clientId, ids));
          setModalOpen(false);
          message.success(ids.length === 1 ? 'Producto asignado.' : 'Productos asignados.');
        }}
      />
    </Card>
  );
}

interface ModalProps {
  open: boolean;
  assignedIds: number[];
  onAssign: (productIds: number[]) => Promise<void>;
  onClose: () => void;
}

/** Elige entre los productos Activos que el cliente todavía no tiene. */
function AssignProductsModal({ open, assignedIds, onAssign, onClose }: ModalProps) {
  const [available, setAvailable] = useState<Product[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Clave estable: el array llega nuevo en cada render del padre.
  const assignedKey = assignedIds.join(',');

  useEffect(() => {
    if (!open) return;
    const excluded = new Set(assignedKey.split(',').filter(Boolean).map(Number));
    setSelected([]);
    setError(null);
    listProducts({ status: 'activo' })
      .then((products) => setAvailable(products.filter((p) => !excluded.has(p.id))))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'No se pudieron cargar los productos.'));
  }, [open, assignedKey]);

  async function handleOk() {
    setSaving(true);
    setError(null);
    try {
      await onAssign(selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron asignar los productos.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      title="Asignar productos"
      okText="Asignar"
      cancelText="Cancelar"
      okButtonProps={{ disabled: selected.length === 0 }}
      confirmLoading={saving}
      onOk={handleOk}
      onCancel={onClose}
      destroyOnHidden
    >
      <Select
        mode="multiple"
        value={selected}
        onChange={setSelected}
        placeholder={available.length === 0 ? 'No hay productos Activos para asignar' : 'Elegí uno o varios productos'}
        disabled={available.length === 0}
        options={available.map((p) => ({
          value: p.id,
          label: `${p.name} — ${formatMoney(p.priceCents, p.currency)}`,
        }))}
        showSearch={{ optionFilterProp: 'label' }}
        style={{ width: '100%', marginBottom: error ? 16 : 0 }}
        aria-label="Productos"
      />
      {error && <Alert type="error" title={error} showIcon />}
    </Modal>
  );
}
