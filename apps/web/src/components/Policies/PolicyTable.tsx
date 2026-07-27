import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { StatusBadge } from "@/components/StatusBadge";
import { Shield, Eye, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

export function PolicyTable({ data, filteredData, handleToggle, setDeleteConfirm, setSelectedPolicy, setViewDialogOpen, setCreateDialogOpen, injectPositionLabel, injectModeLabel }: any) {
  const { t } = useTranslation();

  if (filteredData.length === 0) {
    if (data.length === 0) {
      return (
        <EmptyState
          icon={<Shield className="h-12 w-12" />}
          title={t("policies.empty.title", "暂无提示词策略")}
          description={t("policies.empty.description", "添加您的第一个提示词策略以开始配置")}
          action={{
            label: t("policies.actions.add", "添加策略"),
            onClick: () => setCreateDialogOpen(true),
          }}
        />
      );
    }
    return (
      <EmptyState
        icon={<Shield className="h-12 w-12" />}
        title={t("policies.empty.noResultsTitle", "未找到匹配的策略")}
        description={t("policies.empty.noResultsDesc", "尝试使用其他关键词搜索")}
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("policies.table.name", "名称")}</TableHead>
          <TableHead>{t("policies.table.protocol", "协议")}</TableHead>
          <TableHead>{t("policies.table.injectPosition", "注入位置")}</TableHead>
          <TableHead>{t("policies.table.injectMode", "注入模式")}</TableHead>
          <TableHead>{t("policies.table.version", "版本")}</TableHead>
          <TableHead>{t("policies.table.status", "状态")}</TableHead>
          <TableHead>{t("policies.table.enabled", "启用")}</TableHead>
          <TableHead className="text-right">{t("policies.table.actions", "操作")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {filteredData.map((d: any) => (
          <TableRow key={d.id}>
            <TableCell>
              <div>
                <div className="font-medium">{d.name}</div>
                {d.description && (
                  <div className="text-xs text-muted-foreground">
                    {d.description}
                  </div>
                )}
              </div>
            </TableCell>
            <TableCell>
              <Badge variant="outline">{d.protocol}</Badge>
            </TableCell>
            <TableCell>
              <Badge variant="secondary">
                {injectPositionLabel(d.injectPosition)}
              </Badge>
            </TableCell>
            <TableCell>
              <Badge variant="secondary">
                {injectModeLabel(d.injectMode)}
              </Badge>
            </TableCell>
            <TableCell className="text-muted-foreground">
              v{d.version}
            </TableCell>
            <TableCell>
              <StatusBadge
                status={d.enabled ? "active" : "disabled"}
                label={d.enabled ? t("policies.status.enabled", "已启用") : t("policies.status.disabled", "已禁用")}
              />
            </TableCell>
            <TableCell>
              <Switch
                checked={d.enabled}
                onCheckedChange={(checked) =>
                  handleToggle(d.id, checked)
                }
              />
            </TableCell>
            <TableCell className="text-right">
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSelectedPolicy(d);
                    setViewDialogOpen(true);
                  }}
                >
                  <Eye className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setDeleteConfirm({
                      open: true,
                      id: d.id,
                      name: d.name,
                    })
                  }
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
