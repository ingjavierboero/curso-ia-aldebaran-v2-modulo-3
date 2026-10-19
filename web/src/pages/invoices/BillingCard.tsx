import { StopOutlined, ThunderboltOutlined, UndoOutlined } from '@ant-design/icons';
import { App, Button, Card, Popconfirm, Space, Tag, Tooltip, Typography } from 'antd';
import dayjs from 'dayjs';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelBilling,
  getBillingStatus,
  reactivateBilling,
  runBillingNow,
  type BillingState,
  type BillingStatus,
} from '../../api/billing';
import { useSession } from '../../stores/session';

const STATE_TAGS: Record<BillingState, { color: string; label: string }> = {
  pendiente: { color: 'default', label: 'Pendiente' },
  cancelada: { color: 'red', label: 'Cancelada' },
  en_curso: { color: 'processing', label: 'En curso' },
  realizada: { color: 'green', label: 'Realizada' },
};

/** RF-60, RF-61: motivo por el que "Facturar ahora" está deshabilitado. */
const DISABLED_REASON: Partial<Record<BillingState, string>> = {
  cancelada: 'Deshabilitado: la facturación del mes está cancelada.',
  en_curso: 'Deshabilitado: facturación en curso.',
  realizada: 'Deshabilitado: facturación del mes ya realizada.',
};

const monthName = (period: string) => dayjs(`${period}-01`).format('MMMM [de] YYYY');

function describe(status: BillingStatus): string {
  const at = (iso: string | null) => (iso ? dayjs(iso).format('DD/MM/YYYY HH:mm') : '');
  switch (status.state) {
    case 'pendiente':
      if (!status.schedulerEnabled) {
        return 'Los procesos automáticos están desactivados (SCHEDULER_ENABLED): este mes se factura con "Facturar ahora".';
      }
      return status.due
        ? 'Se va a facturar en el próximo minuto.'
        : `Se factura automáticamente el día 15 a las ${status.billingTime}.`;
    case 'cancelada':
      return `Cancelada el ${at(status.cancelledAt)}. No se va a facturar este mes salvo que la reactives.`;
    case 'en_curso':
      return `Facturando desde el ${at(status.startedAt)}…`;
    case 'realizada':
      return `Facturado el ${at(status.finishedAt)}${status.startedBy ? ' con "Facturar ahora"' : ''}.`;
  }
}

/** Estado de la facturación del mes y acciones del Admin (RF-54 a RF-61). */
export function BillingCard({ onFinished }: { onFinished: () => void }) {
  const isAdmin = useSession((s) => s.user?.role === 'admin');
  const { message } = App.useApp();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const previousState = useRef<BillingState | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getBillingStatus());
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'No se pudo cargar el estado de la facturación.');
    }
  }, [message]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Mientras factura, consulta el estado cada 3 s; al terminar, avisa para recargar el listado.
  useEffect(() => {
    const previous = previousState.current;
    previousState.current = status?.state ?? null;
    if (previous === 'en_curso' && status?.state === 'realizada') {
      message.success('Facturación del mes terminada.');
      onFinished();
    }
    if (status?.state !== 'en_curso') return undefined;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [status?.state, refresh, onFinished, message]);

  async function act(action: () => Promise<BillingStatus>, success: string) {
    setBusy(true);
    try {
      const next = await action();
      setStatus(next);
      message.success(success);
      if (next.state === 'realizada') onFinished();
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'No se pudo completar la acción.');
      void refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!status) return <Card loading style={{ marginBottom: 16 }} />;

  const tag = STATE_TAGS[status.state];
  const disabledReason = DISABLED_REASON[status.state];

  return (
    <Card
      style={{ marginBottom: 16 }}
      title={
        <Space>
          <span>Facturación de {monthName(status.period)}</span>
          <Tag color={tag.color}>{tag.label}</Tag>
        </Space>
      }
      extra={
        isAdmin && (
          <Space wrap>
            {status.state === 'pendiente' && (
              <Popconfirm
                title="¿Cancelar la facturación de este mes?"
                description="El día 15 no se va a facturar."
                okText="Sí, cancelar"
                cancelText="No"
                onConfirm={() => act(cancelBilling, 'Facturación del mes cancelada.')}
              >
                <Button icon={<StopOutlined />} danger loading={busy}>
                  Cancelar el mes
                </Button>
              </Popconfirm>
            )}
            {status.state === 'cancelada' && (
              <Button icon={<UndoOutlined />} loading={busy} onClick={() => act(reactivateBilling, 'Facturación del mes reactivada.')}>
                Reactivar el mes
              </Button>
            )}
            <Tooltip title={disabledReason}>
              <Popconfirm
                title="¿Facturar ahora el mes en curso?"
                description="Se genera y envía la factura de cada cliente Activo con productos Activos."
                okText="Facturar"
                cancelText="No"
                disabled={Boolean(disabledReason)}
                onConfirm={() => act(runBillingNow, 'Facturación iniciada.')}
              >
                <Button type="primary" icon={<ThunderboltOutlined />} disabled={Boolean(disabledReason)} loading={busy}>
                  Facturar ahora
                </Button>
              </Popconfirm>
            </Tooltip>
          </Space>
        )
      }
    >
      <Typography.Text type="secondary">{describe(status)}</Typography.Text>
      {isAdmin && disabledReason && (
        <div>
          <Typography.Text type="secondary">{disabledReason}</Typography.Text>
        </div>
      )}
    </Card>
  );
}
