import { ArrowLeftOutlined, EditOutlined, StopOutlined, UndoOutlined } from '@ant-design/icons';
import { App, Button, Card, Descriptions, Popconfirm, Result, Space, Spin, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import styled from 'styled-components';
import { ApiError } from '../../api/client';
import {
  getClient,
  getClientHistory,
  IVA_CONDITIONS,
  setClientActive,
  updateClient,
  type Client,
  type ClientInput,
} from '../../api/clients';
import { HistoryTimeline } from '../../components/HistoryTimeline';
import { formatCuit } from '../../domain/cuit';
import type { HistoryEvent } from '../../domain/history';
import { formatMoney } from '../../domain/money';
import { useCanEdit } from '../../stores/session';
import { AssignedProductsCard } from './AssignedProductsCard';
import { ClientFormModal } from './ClientFormModal';

const Header = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  margin-bottom: 16px;

  h3 {
    margin: 0;
  }
`;

const Actions = styled(Space)`
  margin-inline-start: auto;
`;

const dateFormat = new Intl.DateTimeFormat('es-AR', { dateStyle: 'long' });

function Missing({ children }: { children: string }) {
  return <Typography.Text type="warning">{children}</Typography.Text>;
}

export function ClientDetailPage() {
  const { id } = useParams();
  const canEdit = useCanEdit();
  const { message } = App.useApp();

  const [client, setClient] = useState<Client | null>(null);
  const [history, setHistory] = useState<HistoryEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [loaded, events] = await Promise.all([getClient(Number(id)), getClientHistory(Number(id))]);
      setClient(loaded);
      setHistory(events);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? 'El cliente no existe.'
          : err instanceof Error
            ? err.message
            : 'No se pudo cargar el cliente.',
      );
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSubmit(input: ClientInput) {
    if (!client) return;
    await updateClient(client.id, input);
    await load();
    setFormOpen(false);
    message.success('Cliente modificado.');
  }

  async function toggleActive() {
    if (!client) return;
    const activate = client.status === 'inactivo';
    try {
      await setClientActive(client.id, activate);
      await load();
      message.success(activate ? 'Cliente reactivado.' : 'Cliente dado de baja.');
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'No se pudo cambiar el estado.');
    }
  }

  const back = (
    <Link to="/clientes">
      <ArrowLeftOutlined /> Volver a clientes
    </Link>
  );

  if (error) {
    return <Result status="warning" title={error} extra={back} />;
  }
  if (!client) {
    return <Spin style={{ display: 'block', marginTop: 64 }} />;
  }

  const active = client.status === 'activo';

  return (
    <>
      <div style={{ marginBottom: 12 }}>{back}</div>
      <Header>
        <Typography.Title level={3}>{client.businessName}</Typography.Title>
        {active ? <Tag color="green">Activo</Tag> : <Tag>Inactivo</Tag>}
        {canEdit && (
          <Actions>
            <Button icon={<EditOutlined />} onClick={() => setFormOpen(true)}>
              Modificar
            </Button>
            <Popconfirm
              title={active ? '¿Dar de baja este cliente?' : '¿Reactivar este cliente?'}
              okText="Sí"
              cancelText="No"
              onConfirm={toggleActive}
            >
              <Button danger={active} icon={active ? <StopOutlined /> : <UndoOutlined />}>
                {active ? 'Dar de baja' : 'Reactivar'}
              </Button>
            </Popconfirm>
          </Actions>
        )}
      </Header>

      <Card title="Datos del cliente">
        <Descriptions column={{ xs: 1, md: 2 }}>
          <Descriptions.Item label="Razón social">{client.businessName}</Descriptions.Item>
          <Descriptions.Item label="CUIT">{formatCuit(client.cuit)}</Descriptions.Item>
          <Descriptions.Item label="Domicilio">
            {client.address ?? <Missing>Sin cargar</Missing>}
          </Descriptions.Item>
          <Descriptions.Item label="Email de facturación">{client.billingEmail}</Descriptions.Item>
          <Descriptions.Item label="Condición frente al IVA">
            {client.ivaCondition === null ? (
              <Missing>Sin cargar</Missing>
            ) : (
              `${IVA_CONDITIONS[client.ivaCondition]} (${client.ivaCondition})`
            )}
          </Descriptions.Item>
          <Descriptions.Item label="Fecha de alta">
            {dateFormat.format(new Date(client.createdAt))}
          </Descriptions.Item>
          <Descriptions.Item label="Deuda vigente">
            {client.debtCents > 0 ? (
              <Link to={`/facturas?clientId=${client.id}`}>{formatMoney(client.debtCents, 'ARS')}</Link>
            ) : (
              formatMoney(0, 'ARS')
            )}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <div style={{ marginTop: 16 }}>
        <AssignedProductsCard clientId={client.id} />
      </div>

      {/* RF-163: historial del cliente, del más reciente al más antiguo. */}
      <Card title="Historial" style={{ marginTop: 16 }}>
        {history && <HistoryTimeline events={history} newestFirst />}
      </Card>

      <ClientFormModal
        open={formOpen}
        client={client}
        onSubmit={handleSubmit}
        onClose={() => setFormOpen(false)}
      />
    </>
  );
}
