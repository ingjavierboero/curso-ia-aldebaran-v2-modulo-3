import { LockOutlined, MailOutlined } from '@ant-design/icons';
import { Alert, Button, Form, Input } from 'antd';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { PublicLayout } from '../layouts/PublicLayout';
import { useSession } from '../stores/session';

interface LoginForm {
  email: string;
  password: string;
}

export function LoginPage() {
  const login = useSession((s) => s.login);
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit({ email, password }: LoginForm) {
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from ?? '/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo iniciar sesión.');
      setSubmitting(false);
    }
  }

  return (
    <PublicLayout title="Iniciar sesión">
      <Form<LoginForm> layout="vertical" onFinish={handleSubmit} requiredMark={false}>
        <Form.Item
          label="Email"
          name="email"
          rules={[{ required: true, message: 'Ingresá tu email.' }]}
        >
          <Input prefix={<MailOutlined />} autoComplete="username" autoFocus />
        </Form.Item>
        <Form.Item
          label="Contraseña"
          name="password"
          rules={[{ required: true, message: 'Ingresá tu contraseña.' }]}
        >
          <Input.Password prefix={<LockOutlined />} autoComplete="current-password" />
        </Form.Item>
        {error && <Alert type="error" title={error} showIcon style={{ marginBottom: 16 }} />}
        <Button type="primary" htmlType="submit" block loading={submitting}>
          Ingresar
        </Button>
      </Form>
    </PublicLayout>
  );
}
