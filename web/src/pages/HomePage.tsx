import { Alert, App, Button, Card, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { getDashboard, type Dashboard, type Debtor } from '../api/dashboard';
import { formatMoney } from '../domain/money';
import { useSession } from '../stores/session';

/** Dashboard principal: banner de errores (RF-181) y clientes con deuda vigente (RF-153). */
export function HomePage() {
  const user = useSession((s) => s.user);
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);

  useEffect(() => {
    getDashboard()
      .then(setDashboard)
      .catch((err) => message.error(err instanceof Error ? err.message : 'No se pudo cargar el dashboard.'));
  }, [message]);

  const today = dayjs().format('YYYY-MM-DD');
  const columns: ColumnsType<Debtor> = [
    {
      title: 'Cliente',
      dataIndex: 'businessName',
      render: (name: string, d) => (
        <>
          {name} {d.status === 'inactivo' && <Tag>Inactivo</Tag>}
        </>
      ),
    },
    {
      title: 'Deuda vigente',
      dataIndex: 'debtCents',
      align: 'right',
      render: (cents: number) => <span style={{ whiteSpace: 'nowrap' }}>{formatMoney(cents, 'ARS')}</span>,
    },
    { title: 'Facturas adeudadas', dataIndex: 'owedCount', align: 'center' },
    {
      title: 'Vencimiento más antiguo',
      dataIndex: 'oldestDueDate',
      render: (date: string) => (
        <Typography.Text type={date < today ? 'danger' : undefined}>{dayjs(date).format('DD/MM/YYYY')}</Typography.Text>
      ),
    },
    {
      title: 'Revisión',
      dataIndex: 'inReview',
      render: (inReview: boolean) => (inReview ? <Tag color="volcano">En revisión</Tag> : null),
    },
  ];

  const pendingErrors = dashboard?.pendingErrors ?? 0;
  const totalDebt = dashboard?.debtors.reduce((sum, d) => sum + d.debtCents, 0) ?? 0;

  return (
    <>
      <Typography.Title level={3}>Hola, {user?.name}</Typography.Title>

      {pendingErrors > 0 && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          title={pendingErrors === 1 ? 'Hay 1 error de proceso pendiente.' : `Hay ${pendingErrors} errores de proceso pendientes.`}
          action={
            <Link to="/revision?tab=errors">
              <Button size="small" danger>
                Ver errores
              </Button>
            </Link>
          }
        />
      )}

      <Card
        title="Clientes con deuda vigente"
        extra={dashboard && dashboard.debtors.length > 0 && <Typography.Text strong>Total: {formatMoney(totalDebt, 'ARS')}</Typography.Text>}
      >
        <Table
          rowKey="id"
          columns={columns}
          dataSource={dashboard?.debtors}
          loading={!dashboard}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          locale={{ emptyText: 'Ningún cliente tiene deuda vigente.' }}
          scroll={{ x: true }}
          onRow={(d) => ({
            onClick: () => navigate(`/clientes/${d.id}`),
            onKeyDown: (e) => {
              if (e.key === 'Enter' && e.target === e.currentTarget) navigate(`/clientes/${d.id}`);
            },
            tabIndex: 0,
            style: { cursor: 'pointer' },
          })}
        />
      </Card>
    </>
  );
}
