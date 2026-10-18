import { Alert, App, Button, Card, DatePicker, Form, Input, InputNumber, Select, Spin, TimePicker, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useState } from 'react';
import styled from 'styled-components';
import { getSettings, saveSettings, type Settings } from '../../api/settings';
import { formatCuit } from '../../domain/cuit';
import { useSession } from '../../stores/session';

const Grid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 0 24px;
`;

const Sections = styled.div`
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 960px;
`;

/** Condiciones frente al IVA de quien puede emitir Factura C. */
const ISSUER_IVA_CONDITIONS = [
  'Responsable Monotributo',
  'IVA Sujeto Exento',
  'Monotributista Social',
  'Monotributo Trabajador Independiente Promovido',
].map((value) => ({ value, label: value }));

const TIME_FORMAT = 'HH:mm';
/** RF-62, RF-152: el PRD admite horarios hasta las 23:39. */
const disabledTime = () => ({
  disabledMinutes: (hour: number) => (hour === 23 ? Array.from({ length: 20 }, (_, i) => 40 + i) : []),
});

interface FormValues {
  mailboxIntervalMinutes: number;
  billingTime: Dayjs;
  reminderTime: Dayjs;
  retryCount: number;
  retryWaitMinutes: number;
  pointOfSale: number;
  issuerBusinessName?: string;
  issuerAddress?: string;
  issuerIvaCondition?: string;
  issuerGrossIncomeNumber?: string;
  issuerActivityStartDate?: Dayjs | null;
}

function toFormValues(s: Settings): FormValues {
  return {
    mailboxIntervalMinutes: s.mailboxIntervalMinutes,
    billingTime: dayjs(s.billingTime, TIME_FORMAT),
    reminderTime: dayjs(s.reminderTime, TIME_FORMAT),
    retryCount: s.retryCount,
    retryWaitMinutes: s.retryWaitMinutes,
    pointOfSale: s.pointOfSale,
    issuerBusinessName: s.issuerBusinessName ?? undefined,
    issuerAddress: s.issuerAddress ?? undefined,
    issuerIvaCondition: s.issuerIvaCondition ?? undefined,
    issuerGrossIncomeNumber: s.issuerGrossIncomeNumber ?? undefined,
    issuerActivityStartDate: s.issuerActivityStartDate ? dayjs(s.issuerActivityStartDate) : null,
  };
}

const textOrNull = (value?: string) => (value?.trim() ? value.trim() : null);

/** Configuración del sistema; solo un Admin la modifica (RF-10, RF-13). */
export function SettingsPage() {
  const isAdmin = useSession((s) => s.user?.role === 'admin');
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [current, setCurrent] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSettings()
      .then((s) => {
        setCurrent(s);
        form.setFieldsValue(toFormValues(s));
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'No se pudo cargar la configuración.'));
  }, [form]);

  async function handleSave(values: FormValues) {
    setSaving(true);
    setError(null);
    try {
      const saved = await saveSettings({
        mailboxIntervalMinutes: values.mailboxIntervalMinutes,
        billingTime: values.billingTime.format(TIME_FORMAT),
        reminderTime: values.reminderTime.format(TIME_FORMAT),
        retryCount: values.retryCount,
        retryWaitMinutes: values.retryWaitMinutes,
        pointOfSale: values.pointOfSale,
        issuerBusinessName: textOrNull(values.issuerBusinessName),
        issuerAddress: textOrNull(values.issuerAddress),
        issuerIvaCondition: values.issuerIvaCondition ?? null,
        issuerGrossIncomeNumber: textOrNull(values.issuerGrossIncomeNumber),
        issuerActivityStartDate: values.issuerActivityStartDate?.format('YYYY-MM-DD') ?? null,
      });
      setCurrent(saved);
      form.setFieldsValue(toFormValues(saved));
      message.success('Configuración guardada.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar la configuración.');
    } finally {
      setSaving(false);
    }
  }

  const required = (label: string) => [{ required: true, message: `Ingresá ${label}.` }];

  return (
    <>
      <Typography.Title level={3}>Configuración</Typography.Title>
      {!isAdmin && (
        <Alert type="info" showIcon title="Solo un Admin puede modificar la configuración." style={{ marginBottom: 16, maxWidth: 960 }} />
      )}
      {/* El form queda montado mientras carga, para que reciba los valores (useForm). */}
      <Spin spinning={!current && !error}>
        <Form<FormValues> form={form} layout="vertical" disabled={!isAdmin} onFinish={handleSave} requiredMark={false}>
          <Sections>
            <Card title="Empresa emisora" extra={<Typography.Text type="secondary">Se muestra en el PDF de cada factura</Typography.Text>}>
              <Grid>
                <Form.Item label="CUIT" htmlFor="issuerCuit" tooltip="Sale de la variable de entorno ARCA_CUIT.">
                  <Input id="issuerCuit" value={current ? formatCuit(current.issuerCuit) : ''} disabled />
                </Form.Item>
                <Form.Item label="Razón social" name="issuerBusinessName">
                  <Input />
                </Form.Item>
                <Form.Item label="Domicilio comercial" name="issuerAddress">
                  <Input />
                </Form.Item>
                <Form.Item label="Condición frente al IVA" name="issuerIvaCondition">
                  <Select options={ISSUER_IVA_CONDITIONS} allowClear placeholder="Elegí una condición" />
                </Form.Item>
                <Form.Item label="Número de ingresos brutos" name="issuerGrossIncomeNumber">
                  <Input />
                </Form.Item>
                <Form.Item label="Fecha de inicio de actividades" name="issuerActivityStartDate">
                  <DatePicker format="DD/MM/YYYY" style={{ width: '100%' }} />
                </Form.Item>
              </Grid>
            </Card>

            <Card title="Facturación">
              <Grid>
                <Form.Item label="Punto de venta de ARCA" name="pointOfSale" rules={required('el punto de venta')}>
                  <InputNumber min={1} max={99_999} precision={0} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item label="Hora de facturación (día 15)" name="billingTime" rules={required('la hora')}>
                  <TimePicker format={TIME_FORMAT} disabledTime={disabledTime} allowClear={false} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item label="Hora de recordatorios (último día del mes)" name="reminderTime" rules={required('la hora')}>
                  <TimePicker format={TIME_FORMAT} disabledTime={disabledTime} allowClear={false} style={{ width: '100%' }} />
                </Form.Item>
              </Grid>
            </Card>

            <Card title="Procesos automáticos">
              <Grid>
                <Form.Item label="Revisión de la casilla cada (minutos)" name="mailboxIntervalMinutes" rules={required('el intervalo')}>
                  <InputNumber min={5} max={60} precision={0} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item label="Reintentos ante una falla" name="retryCount" rules={required('los reintentos')}>
                  <InputNumber min={0} max={10} precision={0} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item label="Espera entre reintentos (minutos)" name="retryWaitMinutes" rules={required('la espera')}>
                  <InputNumber min={1} max={60} precision={0} style={{ width: '100%' }} />
                </Form.Item>
              </Grid>
            </Card>

            {error && <Alert type="error" showIcon title={error} />}
            {isAdmin && (
              <div>
                <Button type="primary" htmlType="submit" loading={saving}>
                  Guardar
                </Button>
              </div>
            )}
          </Sections>
        </Form>
      </Spin>
    </>
  );
}
