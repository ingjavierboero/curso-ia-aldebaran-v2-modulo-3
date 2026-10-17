import { Alert, Button, Form, Input, Typography } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { PublicLayout } from '../layouts/PublicLayout';
import { useSession } from '../stores/session';

/** RF-22: mismo mínimo que valida el server. */
const MIN_PASSWORD_LENGTH = 8;

interface SetupForm {
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
}

/** RF-04: registro del primer usuario, que queda Activo con perfil Admin. */
export function SetupPage() {
  const setup = useSession((s) => s.setup);
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit({ name, email, password }: SetupForm) {
    setError(null);
    setSubmitting(true);
    try {
      await setup({ name, email, password });
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo registrar el usuario.');
      setSubmitting(false);
    }
  }

  return (
    <PublicLayout title="Registrar el primer Admin">
      <Typography.Paragraph type="secondary">
        Todavía no hay usuarios. El usuario que registres ahora va a tener perfil Admin.
      </Typography.Paragraph>
      <Form<SetupForm> layout="vertical" onFinish={handleSubmit} requiredMark={false}>
        <Form.Item
          label="Nombre"
          name="name"
          rules={[{ required: true, whitespace: true, message: 'Ingresá tu nombre.' }]}
        >
          <Input autoComplete="name" autoFocus />
        </Form.Item>
        <Form.Item
          label="Email"
          name="email"
          rules={[
            { required: true, message: 'Ingresá tu email.' },
            { type: 'email', message: 'El email no es válido.' },
          ]}
        >
          <Input autoComplete="username" />
        </Form.Item>
        <Form.Item
          label="Contraseña"
          name="password"
          rules={[
            { required: true, message: 'Ingresá una contraseña.' },
            {
              min: MIN_PASSWORD_LENGTH,
              message: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`,
            },
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          label="Repetir contraseña"
          name="confirmPassword"
          dependencies={['password']}
          rules={[
            { required: true, message: 'Repetí la contraseña.' },
            ({ getFieldValue }) => ({
              validator: (_, value) =>
                !value || value === getFieldValue('password')
                  ? Promise.resolve()
                  : Promise.reject(new Error('Las contraseñas no coinciden.')),
            }),
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        {error && <Alert type="error" title={error} showIcon style={{ marginBottom: 16 }} />}
        <Button type="primary" htmlType="submit" block loading={submitting}>
          Registrar
        </Button>
      </Form>
    </PublicLayout>
  );
}
