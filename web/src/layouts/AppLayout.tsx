import { HomeOutlined } from '@ant-design/icons';
import { Layout, Menu } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router';
import styled from 'styled-components';
import { AppHeader } from '../components/AppHeader';

const Content = styled(Layout.Content)`
  padding: 24px;
`;

const MENU_ITEMS = [{ key: '/', icon: <HomeOutlined />, label: 'Inicio' }];

/** Layout de las pantallas con sesión: header, menú lateral y contenido. */
export function AppLayout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <AppHeader />
      <Layout>
        <Layout.Sider breakpoint="lg" collapsedWidth={0} theme="light" width={220}>
          <Menu
            mode="inline"
            selectedKeys={[pathname]}
            items={MENU_ITEMS}
            onClick={({ key }) => navigate(key)}
            style={{ height: '100%', borderInlineEnd: 0 }}
          />
        </Layout.Sider>
        <Content>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
