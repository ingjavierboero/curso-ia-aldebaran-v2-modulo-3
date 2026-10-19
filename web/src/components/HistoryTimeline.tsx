import { RobotOutlined, UserOutlined } from '@ant-design/icons';
import { Empty, Space, Timeline, Typography } from 'antd';
import dayjs from 'dayjs';
import { describeEvent, type HistoryEvent } from '../domain/history';

/** Línea de tiempo de eventos con fecha, hora y quién lo originó (RF-163, RF-217). */
export function HistoryTimeline({ events, newestFirst = false }: { events: HistoryEvent[]; newestFirst?: boolean }) {
  if (events.length === 0) return <Empty description="Sin eventos." />;
  const ordered = newestFirst ? [...events].reverse() : events;

  return (
    <Timeline
      items={ordered.map((event) => {
        const { title, details, color } = describeEvent(event);
        return {
          key: event.id,
          color,
          content: (
            <>
              <Typography.Text strong>{title}</Typography.Text>
              <div>
                <Space size={12} wrap>
                  <Typography.Text type="secondary">{dayjs(event.createdAt).format('DD/MM/YYYY HH:mm')}</Typography.Text>
                  <Typography.Text type="secondary">
                    {event.userName ? <UserOutlined /> : <RobotOutlined />} {event.userName ?? 'Agente'}
                  </Typography.Text>
                </Space>
              </div>
              {details.map((line, i) => (
                <div key={i}>
                  <Typography.Text>{line}</Typography.Text>
                </div>
              ))}
            </>
          ),
        };
      })}
    />
  );
}
