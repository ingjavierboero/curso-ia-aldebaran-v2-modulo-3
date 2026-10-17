import { Alert, Form, Input, InputNumber, Modal, Radio } from 'antd';
import { useEffect, useState } from 'react';
import type { Product, ProductInput } from '../../api/products';
import { CURRENCY_LABELS, toCents, type Currency } from '../../domain/money';

interface FormValues {
  name: string;
  currency: Currency;
  /** Importe con decimales, tal como lo escribe el usuario. */
  price: number;
}

interface Props {
  open: boolean;
  /** Producto a modificar; sin producto, es un alta. */
  product: Product | null;
  onSubmit: (input: ProductInput) => Promise<void>;
  onClose: () => void;
}

export function ProductFormModal({ open, product, onSubmit, onClose }: Props) {
  const [form] = Form.useForm<FormValues>();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const currency = Form.useWatch('currency', form);

  useEffect(() => {
    if (!open) return;
    setError(null);
    form.resetFields();
    if (product) {
      form.setFieldsValue({
        name: product.name,
        currency: product.currency,
        price: product.priceCents / 100,
      });
    }
  }, [open, product, form]);

  async function handleOk() {
    const values = await form.validateFields().catch(() => null);
    if (!values) return;

    setSaving(true);
    setError(null);
    try {
      await onSubmit({ name: values.name, currency: values.currency, priceCents: toCents(values.price) });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar el producto.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      title={product ? 'Modificar producto' : 'Nuevo producto'}
      okText={product ? 'Guardar' : 'Dar de alta'}
      cancelText="Cancelar"
      confirmLoading={saving}
      onOk={handleOk}
      onCancel={onClose}
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        initialValues={{ currency: 'ARS' }}
        onFinish={handleOk}
      >
        <Form.Item
          label="Nombre"
          name="name"
          rules={[{ required: true, whitespace: true, message: 'Ingresá el nombre.' }]}
        >
          <Input autoFocus />
        </Form.Item>
        <Form.Item label="Moneda" name="currency">
          <Radio.Group
            options={Object.entries(CURRENCY_LABELS).map(([value, label]) => ({ value, label }))}
            optionType="button"
          />
        </Form.Item>
        <Form.Item
          label="Precio de la cuota mensual"
          name="price"
          rules={[
            { required: true, message: 'Ingresá el precio.' },
            {
              validator: (_, value?: number) =>
                value === undefined || value === null || value > 0
                  ? Promise.resolve()
                  : Promise.reject(new Error('El precio debe ser mayor a cero.')),
            },
          ]}
        >
          <InputNumber
            prefix={currency === 'USD' ? 'US$' : '$'}
            min={0}
            precision={2}
            decimalSeparator=","
            style={{ width: '100%' }}
          />
        </Form.Item>
        {error && <Alert type="error" title={error} showIcon />}
      </Form>
    </Modal>
  );
}
