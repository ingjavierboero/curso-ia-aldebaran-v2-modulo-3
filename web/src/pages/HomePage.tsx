import { Empty, Typography } from 'antd';
import { useSession } from '../stores/session';

/** Placeholder: el dashboard llega con la feature de revisión de pagos. */
export function HomePage() {
  const user = useSession((s) => s.user);

  return (
    <>
      <Typography.Title level={3}>Hola, {user?.name}</Typography.Title>
      <Empty description="Todavía no hay nada para mostrar." />
    </>
  );
}
