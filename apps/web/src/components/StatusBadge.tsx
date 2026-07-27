import { Badge } from "@/components/ui/badge";

type Status = "active" | "inactive" | "disabled" | "pending" | "error" | "success";

interface StatusBadgeProps {
  status: Status;
  label?: string;
}

const statusConfig: Record<Status, { variant: "default" | "secondary" | "destructive" | "outline"; className?: string }> = {
  active: { variant: "default", className: "bg-green-100 text-green-800 border-green-200" },
  inactive: { variant: "secondary" },
  disabled: { variant: "destructive" },
  pending: { variant: "secondary", className: "bg-yellow-100 text-yellow-800 border-yellow-200" },
  error: { variant: "destructive" },
  success: { variant: "default", className: "bg-green-100 text-green-800 border-green-200" },
};

const statusLabels: Record<Status, string> = {
  active: "启用",
  inactive: "未启用",
  disabled: "已禁用",
  pending: "待处理",
  error: "错误",
  success: "成功",
};

export function StatusBadge({ status, label }: StatusBadgeProps) {
  const config = statusConfig[status];
  const displayLabel = label || statusLabels[status];

  return (
    <Badge variant={config.variant} className={config.className}>
      {displayLabel}
    </Badge>
  );
}
