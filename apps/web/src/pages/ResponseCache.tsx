import { useState, useEffect } from "react";
import { fetchApi } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Database, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useSettings } from "@/contexts/SettingsContext";

interface CacheEntry {
  id: string;
  inputText: string;
  responseText: string;
  model: string;
  hitCount: number;
  lastHitAt: string | null;
  createdAt: string;
  sourceLogId?: string;
}

export default function ResponseCache() {
  const { t } = useTranslation();
  const { formatDateTime } = useSettings();
  const [data, setData] = useState<CacheEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    open: boolean;
    id: string | null;
  }>({ open: false, id: null });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const res = await fetchApi("/admin/cache");
      setData(Array.isArray(res) ? res : res.data || []);
    } catch (e: any) {
      toast.error(t("responseCache.title", "响应缓存") + ": " + e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirm.id) return;
    try {
      await fetchApi(`/admin/cache/${deleteConfirm.id}`, {
        method: "DELETE",
      });
      toast.success(t("responseCache.deleteSuccess", "删除成功"));
      loadData();
      setDeleteConfirm({ open: false, id: null });
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return "-";
    return formatDateTime(dateStr);
  };

  const truncate = (text: string, max: number = 50) => {
    if (text.length <= max) return text;
    return text.substring(0, max) + "…";
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <Skeleton className="h-8 w-48" />
        </div>
        <Card>
          <CardContent className="p-6">
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center gap-4">
        <div className="text-sm text-muted-foreground">
          {t("responseCache.total", "共 {{count}} 条缓存", { count: data.length })}
        </div>
      </div>

      {/* Cache Table */}
      <Card>
        <CardContent className="p-0">
          {data.length === 0 ? (
            <EmptyState
              icon={<Database className="h-12 w-12" />}
              title={t("responseCache.empty", "暂无缓存条目")}
              description={t("responseCache.emptyDesc", "在审计日志中点击缓存按钮来添加条目")}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>{t("responseCache.inputText", "用户输入")}</TableHead>
                  <TableHead>{t("responseCache.model", "模型")}</TableHead>
                  <TableHead className="text-center">{t("responseCache.hitCount", "命中次数")}</TableHead>
                  <TableHead>{t("responseCache.lastHitAt", "最后命中")}</TableHead>
                  <TableHead>{t("responseCache.createdAt", "创建时间")}</TableHead>
                  <TableHead className="text-right">{t("responseCache.actions", "操作")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((entry) => {
                  const isExpanded = expandedId === entry.id;
                  return (
                    <>
                      <TableRow
                        key={entry.id}
                        className="cursor-pointer hover:bg-accent/40"
                        onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                      >
                        <TableCell className="px-3">
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          )}
                        </TableCell>
                        <TableCell>
                          <span title={entry.inputText} className="font-mono text-xs">
                            {truncate(entry.inputText)}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{entry.model}</Badge>
                        </TableCell>
                        <TableCell className="text-center">
                          <Badge variant="secondary">{entry.hitCount}</Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs">
                          {formatDate(entry.lastHitAt)}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs">
                          {formatDate(entry.createdAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteConfirm({ open: true, id: entry.id });
                            }}
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                      {isExpanded && (
                        <TableRow key={`${entry.id}-detail`}>
                          <TableCell colSpan={7} className="bg-muted/30 p-0">
                            <div className="p-4 space-y-3">
                              <div>
                                <div className="text-xs font-semibold text-muted-foreground mb-1">
                                  {t("responseCache.inputText", "用户输入")}
                                </div>
                                <pre className="p-3 bg-background rounded-md border text-xs font-mono overflow-auto max-h-48 whitespace-pre-wrap break-words">
                                  {entry.inputText}
                                </pre>
                              </div>
                              <div>
                                <div className="text-xs font-semibold text-muted-foreground mb-1">
                                  {t("responseCache.responseText", "缓存回复")}
                                </div>
                                <pre className="p-3 bg-background rounded-md border text-xs font-mono overflow-auto max-h-64 whitespace-pre-wrap break-words">
                                  {entry.responseText}
                                </pre>
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={(open) => setDeleteConfirm({ ...deleteConfirm, open })}
        title={t("responseCache.delete", "删除")}
        description={t("responseCache.confirmDelete", "确定要删除此缓存条目吗？")}
        confirmLabel={t("common.delete", "删除")}
        variant="destructive"
        onConfirm={handleDelete}
      />
    </div>
  );
}
