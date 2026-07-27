import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Copy, Check, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

interface KeyDisplayProps {
  keyValue: string;
  label?: string;
  warning?: string;
}

export function KeyDisplay({ keyValue, label = "密钥", warning }: KeyDisplayProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(keyValue);
      setCopied(true);
      toast.success("已复制到剪贴板");
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      toast.error("复制失败");
    }
  };

  return (
    <Card className="border-yellow-200 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-950/20">
      <CardContent className="p-4">
        {warning && (
          <div className="mb-3 flex items-start gap-2 text-yellow-800 dark:text-yellow-200">
            <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <p className="text-sm">{warning}</p>
          </div>
        )}
        <div className="space-y-2">
          <label className="text-sm font-medium text-yellow-900 dark:text-yellow-100">
            {label}
          </label>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded-md border border-yellow-200 bg-white px-3 py-2 font-mono text-sm text-yellow-950 dark:border-yellow-700 dark:bg-yellow-50 dark:text-yellow-950">
              {keyValue}
            </code>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopy}
              className="flex-shrink-0"
            >
              {copied ? (
                <>
                  <Check className="h-4 w-4 mr-1" />
                  已复制
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4 mr-1" />
                  复制
                </>
              )}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
