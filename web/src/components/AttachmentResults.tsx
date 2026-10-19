import { PaperClipOutlined } from '@ant-design/icons';
import { Table, Tag, Tooltip, Typography } from 'antd';

export interface AttachmentResult {
  filename: string;
  valid: boolean;
  classification: 'si' | 'no' | 'dudoso' | null;
  cuit: string | null;
  amount: string | null;
  error: string | null;
  /** URL de descarga, si se puede bajar. */
  href?: string;
}

const CLASS_COLORS = { si: 'green', no: 'default', dudoso: 'gold' } as const;

/** Resultado de cada adjunto de un email: clasificación del LLM, CUIT y monto extraídos (RF-141). */
export function AttachmentResults({ attachments }: { attachments: AttachmentResult[] }) {
  return (
    <Table
      size="small"
      pagination={false}
      rowKey={(a) => `${a.filename}-${a.href ?? ''}`}
      dataSource={attachments}
      scroll={{ x: true }}
      columns={[
        {
          title: 'Adjunto',
          dataIndex: 'filename',
          render: (name: string, a) =>
            a.href ? (
              <a href={a.href} target="_blank" rel="noreferrer">
                <PaperClipOutlined /> {name}
              </a>
            ) : (
              name
            ),
        },
        {
          title: 'Clasificación',
          key: 'classification',
          render: (_, a) =>
            !a.valid ? (
              <Tooltip title="No es una imagen ni un PDF, o está embebida en el cuerpo: no se procesa.">
                <Typography.Text type="secondary">no se procesa</Typography.Text>
              </Tooltip>
            ) : a.error ? (
              <Tooltip title={a.error}>
                <Tag color="red">Erróneo</Tag>
              </Tooltip>
            ) : a.classification ? (
              <Tag color={CLASS_COLORS[a.classification]}>{a.classification}</Tag>
            ) : (
              <Typography.Text type="secondary">—</Typography.Text>
            ),
        },
        { title: 'CUIT extraído', dataIndex: 'cuit', render: (v: string | null, a) => (a.classification === 'si' ? (v ?? 'no extraído') : '') },
        { title: 'Monto extraído', dataIndex: 'amount', render: (v: string | null, a) => (a.classification === 'si' ? (v ?? 'no extraído') : '') },
      ]}
    />
  );
}
