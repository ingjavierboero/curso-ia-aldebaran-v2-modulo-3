import { PaperClipOutlined, PlusOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Collapse, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import styled from 'styled-components';
import { listMockEmails, mockAttachmentUrl, type MockEmail } from '../../api/mockMailbox';
import { useCanEdit, useSession } from '../../stores/session';
import { ProcessingDetail, ProcessingTag } from './ProcessingDetail';
import { UploadEmailModal } from './UploadEmailModal';

/** Email y procesamiento lado a lado; en pantallas angostas, uno debajo del otro. */
const Details = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: 12px;
  align-items: start;
`;

const Body = styled.pre`
  white-space: pre-wrap;
  font-family: inherit;
  margin: 0 0 8px;
`;

const RULES = [
  ['pago_<CUIT>_<monto>.pdf', 'comprobante ("si") con ese CUIT y monto, con punto decimal. Ej.: pago_30711111111_15000.50.pdf'],
  ['pago_x_<monto>.pdf o pago_<CUIT>_x.pdf', 'comprobante del que no se pudo extraer el CUIT o el monto'],
  ['dudoso…', 'clasificación "dudoso"'],
  ['error…', 'procesamiento erróneo'],
  ['cualquier otro nombre', 'no es un comprobante ("no")'],
];

/** RF-197 a RF-200: casilla simulada del modo mock. */
export function MockMailboxPage() {
  const canUpload = useCanEdit();
  const isAdmin = useSession((s) => s.user?.role === 'admin');
  const { message } = App.useApp();
  const [emails, setEmails] = useState<MockEmail[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEmails(await listMockEmails());
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'No se pudo cargar la casilla.');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ColumnsType<MockEmail> = [
    { title: 'Fecha', dataIndex: 'date', width: 150, render: (d: string) => dayjs(d).format('DD/MM/YYYY HH:mm') },
    {
      title: 'Tipo',
      dataIndex: 'direction',
      width: 100,
      render: (d: MockEmail['direction']) => (d === 'enviado' ? <Tag color="blue">Enviado</Tag> : <Tag color="green">Recibido</Tag>),
    },
    { title: 'De', dataIndex: 'from' },
    { title: 'Para', dataIndex: 'to' },
    { title: 'Asunto', dataIndex: 'subject' },
    {
      title: 'Procesamiento',
      key: 'processing',
      render: (_, e) => <ProcessingTag processing={e.processing} />,
    },
    {
      title: <PaperClipOutlined aria-label="Adjuntos" />,
      key: 'attachments',
      align: 'center',
      width: 60,
      render: (_, e) => e.attachments.length || '',
    },
  ];

  return (
    <>
      <Typography.Title level={3}>Casilla simulada</Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        title="Reemplaza a Gmail en modo mock"
        description={
          isAdmin
            ? 'Acá quedan los emails que envía el sistema y los recibidos que cargues. Los recibidos se procesan en la siguiente revisión de la casilla.'
            : 'Ves los emails recibidos desde el email de facturación de un cliente.'
        }
      />
      <Collapse
        style={{ marginBottom: 16 }}
        items={[
          {
            key: 'rules',
            label: 'Cómo se clasifican los adjuntos en modo mock (por su nombre de archivo)',
            children: (
              <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                {RULES.map(([name, meaning]) => (
                  <li key={name}>
                    <Typography.Text code>{name}</Typography.Text>: {meaning}
                  </li>
                ))}
              </ul>
            ),
          },
        ]}
      />
      {canUpload && (
        <div style={{ marginBottom: 16, textAlign: 'right' }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setUploadOpen(true)}>
            Cargar email recibido
          </Button>
        </div>
      )}
      <Table
        rowKey="id"
        columns={columns}
        dataSource={emails}
        loading={loading}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        locale={{ emptyText: 'La casilla está vacía.' }}
        scroll={{ x: true }}
        expandable={{
          expandRowByClick: true,
          expandedRowRender: (email) => (
            <Details>
              <Card size="small" title="Email">
                <Body>{email.text || '(sin cuerpo)'}</Body>
                {email.attachments.length > 0 && (
                  <Space wrap>
                    {email.attachments.map((a) => (
                      <a key={a.id} href={mockAttachmentUrl(email.id, a.id)} target="_blank" rel="noreferrer">
                        <PaperClipOutlined /> {a.filename}
                        {a.inline && ' (embebida)'}
                      </a>
                    ))}
                  </Space>
                )}
              </Card>
              {email.processing && (
                <Card size="small" title="Procesamiento del agente" extra={<ProcessingTag processing={email.processing} />}>
                  <ProcessingDetail processing={email.processing} />
                </Card>
              )}
            </Details>
          ),
        }}
      />
      <UploadEmailModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUploaded={() => {
          setUploadOpen(false);
          message.success('Email cargado.');
          void load();
        }}
      />
    </>
  );
}
