import { Alert, Form, Input, Modal, Select } from 'antd';
import { useEffect, useState } from 'react';
import { IVA_CONDITIONS, type Client, type ClientInput } from '../../api/clients';
import { formatCuit, isValidCuit } from '../../domain/cuit';

const IVA_OPTIONS = Object.entries(IVA_CONDITIONS).map(([code, label]) => ({
  value: Number(code),
  label: `${label} (${code})`,
}));

interface Props {
  open: boolean;
  /** Cliente a modificar; sin cliente, es un alta. */
  client: Client | null;
  onSubmit: (input: ClientInput) => Promise<void>;
  onClose: () => void;
}

export function ClientFormModal({ open, client, onSubmit, onClose }: Props) {
  const [form] = Form.useForm<ClientInput>();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    form.resetFields();
    if (client) {
      form.setFieldsValue({
        businessName: client.businessName,
        cuit: formatCuit(client.cuit),
        address: client.address ?? undefined,
        billingEmail: client.billingEmail,
        ivaCondition: client.ivaCondition ?? undefined,
      });
    }
  }, [open, client, form]);

  async function handleOk() {
    const values = await form.validateFields().catch(() => null);
    if (!values) return;

    setSaving(true);
    setError(null);
    try {
      await onSubmit(values);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar el cliente.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      title={client ? 'Modificar cliente' : 'Nuevo cliente'}
      okText={client ? 'Guardar' : 'Dar de alta'}
      cancelText="Cancelar"
      confirmLoading={saving}
      onOk={handleOk}
      onCancel={onClose}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" requiredMark={false} onFinish={handleOk}>
        <Form.Item
          label="Razón social"
          name="businessName"
          rules={[{ required: true, whitespace: true, message: 'Ingresá la razón social.' }]}
        >
          <Input autoFocus />
        </Form.Item>
        <Form.Item
          label="CUIT"
          name="cuit"
          rules={[
            { required: true, message: 'Ingresá el CUIT.' },
            {
              validator: (_, value?: string) =>
                !value || isValidCuit(value)
                  ? Promise.resolve()
                  : Promise.reject(new Error('El CUIT no es válido: revisá el dígito verificador.')),
            },
          ]}
        >
          <Input placeholder="30-71111111-1" />
        </Form.Item>
        <Form.Item
          label="Domicilio"
          name="address"
          rules={[{ required: true, whitespace: true, message: 'Ingresá el domicilio.' }]}
        >
          <Input placeholder="Calle y número, localidad, provincia" />
        </Form.Item>
        <Form.Item
          label="Email de facturación"
          name="billingEmail"
          rules={[
            { required: true, message: 'Ingresá el email de facturación.' },
            { type: 'email', message: 'El email no es válido.' },
          ]}
        >
          <Input />
        </Form.Item>
        <Form.Item
          label="Condición frente al IVA"
          name="ivaCondition"
          rules={[{ required: true, message: 'Elegí la condición frente al IVA.' }]}
        >
          <Select options={IVA_OPTIONS} placeholder="Elegí una condición" showSearch={{ optionFilterProp: 'label' }} />
        </Form.Item>
        {error && <Alert type="error" title={error} showIcon />}
      </Form>
    </Modal>
  );
}
