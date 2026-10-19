import { InboxOutlined } from '@ant-design/icons';
import { Alert, Button, Checkbox, Form, Input, Modal, Upload, type UploadFile } from 'antd';
import { useEffect, useState } from 'react';
import styled from 'styled-components';
import { fileToBase64, uploadMockEmail } from '../../api/mockMailbox';

const Files = styled.ul`
  list-style: none;
  margin: 8px 0 0;
  padding: 0;

  li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
  }

  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;

interface FormValues {
  from: string;
  subject?: string;
  text?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onUploaded: () => void;
}

/** RF-200: cargar un email recibido en la casilla simulada, con sus adjuntos. */
export function UploadEmailModal({ open, onClose, onUploaded }: Props) {
  const [form] = Form.useForm<FormValues>();
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [inline, setInline] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    setFiles([]);
    setInline(new Set());
    setError(null);
  }, [open, form]);

  async function handleOk() {
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
    setSaving(true);
    setError(null);
    try {
      const attachments = await Promise.all(
        files.map(async (f) => ({
          filename: f.name,
          contentType: f.type ?? '',
          inline: inline.has(f.uid),
          contentBase64: await fileToBase64(f.originFileObj as Blob),
        })),
      );
      await uploadMockEmail({ from: values.from, subject: values.subject ?? '', text: values.text ?? '', attachments });
      onUploaded();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar el email.');
    } finally {
      setSaving(false);
    }
  }

  const toggleInline = (uid: string, checked: boolean) =>
    setInline((current) => {
      const next = new Set(current);
      if (checked) next.add(uid);
      else next.delete(uid);
      return next;
    });

  return (
    <Modal
      open={open}
      title="Cargar email recibido"
      okText="Cargar"
      cancelText="Cancelar"
      confirmLoading={saving}
      onOk={handleOk}
      onCancel={onClose}
      width={600}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item
          label="Remitente"
          name="from"
          tooltip="Para que se reconozca como de un cliente, usá su email de facturación."
          rules={[
            { required: true, message: 'Ingresá el remitente.' },
            { type: 'email', message: 'El remitente no es un email válido.' },
          ]}
        >
          <Input placeholder="pagos@cliente.com" autoFocus />
        </Form.Item>
        <Form.Item label="Asunto" name="subject">
          <Input />
        </Form.Item>
        <Form.Item label="Cuerpo" name="text">
          <Input.TextArea rows={4} />
        </Form.Item>
        <Form.Item label="Adjuntos">
          <Upload.Dragger
            multiple
            fileList={files}
            beforeUpload={() => false}
            onChange={({ fileList }) => setFiles(fileList)}
            showUploadList={false}
          >
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
            <p className="ant-upload-text">Arrastrá archivos o hacé click para elegirlos</p>
          </Upload.Dragger>
          {files.length > 0 && (
            <Files>
              {files.map((file) => (
                <li key={file.uid}>
                  <span className="name">{file.name}</span>
                  <Checkbox checked={inline.has(file.uid)} onChange={(e) => toggleInline(file.uid, e.target.checked)}>
                    Embebida en el cuerpo
                  </Checkbox>
                  <Button type="link" size="small" onClick={() => setFiles((list) => list.filter((f) => f.uid !== file.uid))}>
                    Quitar
                  </Button>
                </li>
              ))}
            </Files>
          )}
        </Form.Item>
        {error && <Alert type="error" showIcon title={error} />}
      </Form>
    </Modal>
  );
}
