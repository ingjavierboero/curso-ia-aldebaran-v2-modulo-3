import { Card, Layout } from 'antd';
import type { ReactNode } from 'react';
import styled from 'styled-components';
import { AppHeader } from '../components/AppHeader';

const Center = styled(Layout.Content)`
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 64px 16px;
`;

const FormCard = styled(Card)`
  width: 100%;
  max-width: 400px;
`;

/** Layout de las pantallas sin sesión (login y registro del primer Admin). */
export function PublicLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <AppHeader />
      <Center>
        <FormCard title={title}>{children}</FormCard>
      </Center>
    </Layout>
  );
}
