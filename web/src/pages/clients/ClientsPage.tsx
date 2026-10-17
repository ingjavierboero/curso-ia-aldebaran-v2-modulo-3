import { EditOutlined, PlusOutlined, StopOutlined, UndoOutlined } from '@ant-design/icons';
import { App, Button, Input, Segmented, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import styled from 'styled-components';
import {
  createClient,
  IVA_CONDITIONS,
  listClients,
  setClientActive,
  updateClient,
  type Client,
  type ClientInput,
  type ClientStatus,
} from '../../api/clients';
import { TableAction } from '../../components/TableAction';
import { formatCuit } from '../../domain/cuit';
import { useCanEdit } from '../../stores/session';
import { ClientFormModal } from './ClientFormModal';

const Toolbar = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  margin-bottom: 16px;
`;

type StatusFilter = ClientStatus | 'todos';

const STATUS_OPTIONS = [
  { value: 'todos', label: 'Todos' },
  { value: 'activo', label: 'Activos' },
  { value: 'inactivo', label: 'Inactivos' },
];

export function ClientsPage() {
  const canEdit = useCanEdit();
  const { message } = App.useApp();
  const navigate = useNavigate();

  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<StatusFilter>('todos');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Client | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setClients(await listClients({ status: status === 'todos' ? undefined : status, q: search }));
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'No se pudieron cargar los clientes.');
    } finally {
      setLoading(false);
    }
  }, [status, search, message]);

  useEffect(() => {
    void load();
  }, [load]);

  function openForm(client: Client | null) {
    setEditing(client);
    setFormOpen(true);
  }

  async function handleSubmit(input: ClientInput) {
    if (editing) {
      await updateClient(editing.id, input);
      message.success('Cliente modificado.');
    } else {
      await createClient(input);
      message.success('Cliente dado de alta.');
    }
    setFormOpen(false);
    await load();
  }

  async function toggleActive(client: Client) {
    const activate = client.status === 'inactivo';
    try {
      await setClientActive(client.id, activate);
      message.success(activate ? 'Cliente reactivado.' : 'Cliente dado de baja.');
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'No se pudo cambiar el estado.');
    }
  }

  const columns: ColumnsType<Client> = [
    { title: 'Razón social', dataIndex: 'businessName' },
    { title: 'CUIT', dataIndex: 'cuit', render: (cuit: string) => formatCuit(cuit) },
    { title: 'Email de facturación', dataIndex: 'billingEmail' },
    {
      title: 'Condición frente al IVA',
      dataIndex: 'ivaCondition',
      render: (code: number | null) =>
        code === null ? <Typography.Text type="warning">Sin cargar</Typography.Text> : IVA_CONDITIONS[code],
    },
    {
      title: 'Estado',
      dataIndex: 'status',
      render: (value: ClientStatus) =>
        value === 'activo' ? <Tag color="green">Activo</Tag> : <Tag>Inactivo</Tag>,
    },
  ];

  if (canEdit) {
    columns.push({
      title: 'Acciones',
      key: 'actions',
      align: 'center',
      width: 100,
      render: (_, client) => {
        const active = client.status === 'activo';
        return (
          <Space size={4}>
            <TableAction label="Modificar" icon={<EditOutlined />} onClick={() => openForm(client)} />
            <TableAction
              label={active ? 'Dar de baja' : 'Reactivar'}
              icon={active ? <StopOutlined /> : <UndoOutlined />}
              danger={active}
              confirm={active ? '¿Dar de baja este cliente?' : '¿Reactivar este cliente?'}
              onClick={() => toggleActive(client)}
            />
          </Space>
        );
      },
    });
  }

  return (
    <>
      <Typography.Title level={3}>Clientes</Typography.Title>
      <Toolbar>
        <Input.Search
          placeholder="Buscar por razón social o CUIT"
          allowClear
          onSearch={(value) => setSearch(value.trim())}
          style={{ maxWidth: 320 }}
        />
        <Segmented options={STATUS_OPTIONS} value={status} onChange={(v) => setStatus(v as StatusFilter)} />
        {canEdit && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openForm(null)} style={{ marginInlineStart: 'auto' }}>
            Nuevo cliente
          </Button>
        )}
      </Toolbar>
      <Table
        rowKey="id"
        columns={columns}
        dataSource={clients}
        loading={loading}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        locale={{ emptyText: search || status !== 'todos' ? 'Ningún cliente coincide con el filtro.' : 'Todavía no hay clientes.' }}
        scroll={{ x: true }}
        onRow={(client) => ({
          // Click o Enter en la fila abre el detalle del cliente.
          onClick: () => navigate(`/clientes/${client.id}`),
          onKeyDown: (e) => {
            if (e.key === 'Enter' && e.target === e.currentTarget) navigate(`/clientes/${client.id}`);
          },
          tabIndex: 0,
          style: { cursor: 'pointer' },
        })}
      />
      <ClientFormModal
        open={formOpen}
        client={editing}
        onSubmit={handleSubmit}
        onClose={() => setFormOpen(false)}
      />
    </>
  );
}
