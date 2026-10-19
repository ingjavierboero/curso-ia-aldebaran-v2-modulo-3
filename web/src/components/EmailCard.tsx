import { Card, Space, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import styled from 'styled-components';
import { receivedAttachmentUrl, type ReceivedEmail } from '../api/review';
import { AttachmentResults } from './AttachmentResults';

export const Body = styled.pre`
  white-space: pre-wrap;
  font-family: inherit;
  margin: 0 0 8px;
`;

/** Varias cards de email, una debajo de la otra. */
export const Emails = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
`;

const EMAIL_CLASS: Record<NonNullable<ReceivedEmail['classification']>, { label: string; color: string }> = {
  si: { label: 'Comprobante', color: 'green' },
  no: { label: 'No es comprobante', color: 'default' },
  dudoso: { label: 'Dudoso', color: 'gold' },
  erroneo: { label: 'Procesamiento erróneo', color: 'red' },
};

/** Un email recibido con su cuerpo y el resultado de cada adjunto (RF-141, RF-216, RF-217). */
export function EmailCard({ email }: { email: ReceivedEmail }) {
  const cls = email.classification ? EMAIL_CLASS[email.classification] : null;
  return (
    <Card
      size="small"
      title={
        <Space wrap size={4}>
          <span>{email.subject || '(sin asunto)'}</span>
          <Typography.Text type="secondary" style={{ fontWeight: 'normal' }}>
            · {email.from} · {dayjs(email.receivedAt).format('DD/MM/YYYY HH:mm')}
          </Typography.Text>
        </Space>
      }
      extra={cls && <Tag color={cls.color}>{cls.label}</Tag>}
    >
      <Body>{email.text.trim() || '(sin cuerpo)'}</Body>
      {email.attachments.length > 0 && (
        <AttachmentResults
          attachments={email.attachments.map((a) => ({ ...a, href: receivedAttachmentUrl(email.id, a.id) }))}
        />
      )}
    </Card>
  );
}
