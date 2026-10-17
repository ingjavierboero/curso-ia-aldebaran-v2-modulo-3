import { LogoutOutlined, UserOutlined } from '@ant-design/icons';
import { App, Avatar, Dropdown, Layout, Space, Typography } from 'antd';
import { useNavigate } from 'react-router';
import styled from 'styled-components';
import { ROLE_LABELS } from '../api/types';
import { useSession } from '../stores/session';
import { MockModeIndicator } from './MockModeIndicator';
import { ThemeSwitcher } from './ThemeSwitcher';

const Header = styled(Layout.Header)`
  display: flex;
  align-items: center;
  gap: 16px;
  padding-inline: 24px;
`;

const Brand = styled(Typography.Title).attrs({ level: 4 })`
  && {
    margin: 0;
    color: #fff;
    white-space: nowrap;
  }
`;

const Spacer = styled.div`
  flex: 1;
`;

const UserButton = styled.button`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  border: 0;
  background: none;
  color: #fff;
  cursor: pointer;
`;

export function AppHeader() {
  const user = useSession((s) => s.user);
  const logout = useSession((s) => s.logout);
  const navigate = useNavigate();
  const { message } = App.useApp();

  async function handleLogout() {
    try {
      await logout();
      navigate('/login', { replace: true });
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'No se pudo cerrar la sesión.');
    }
  }

  return (
    <Header>
      <Brand>Aldebaran</Brand>
      <MockModeIndicator />
      <Spacer />
      <ThemeSwitcher />
      {user && (
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              {
                key: 'info',
                type: 'group',
                label: (
                  <Space orientation="vertical" size={0}>
                    <Typography.Text>{user.email}</Typography.Text>
                    <Typography.Text type="secondary">{ROLE_LABELS[user.role]}</Typography.Text>
                  </Space>
                ),
              },
              { type: 'divider' },
              { key: 'logout', icon: <LogoutOutlined />, label: 'Cerrar sesión', onClick: handleLogout },
            ],
          }}
        >
          <UserButton type="button" aria-label="Menú de usuario">
            <Avatar size="small" icon={<UserOutlined />} />
            <span>{user.name}</span>
          </UserButton>
        </Dropdown>
      )}
    </Header>
  );
}
