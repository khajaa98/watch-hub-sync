/**
 * src/app/(app)/dashboard/_components/dashboard-client.tsx
 *
 * Client-side interactivity island for the dashboard page.
 * Manages: Create Room dialog open/close state + optimistic room list updates.
 */

"use client";

import { useState, useCallback } from "react";
import { AnimatePresence } from "framer-motion";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CreateRoomDialog } from "./create-room-dialog";
import type { RoomRow } from "@/types/supabase";
import { useRouter } from "next/navigation";

interface DashboardClientProps {
  readonly userId: string;
  readonly isPremium: boolean;
  readonly initialRooms: RoomRow[];
}

interface CreatedRoom {
  id: string;
  inviteUrl: string;
  liveKitRoomName: string;
}

export function DashboardClient({
  isPremium,
}: DashboardClientProps) {
  const router = useRouter();
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const handleCreated = useCallback(
    (room: CreatedRoom) => {
      // Refresh server data so the new room appears in the RSC-rendered grid.
      // We do NOT optimistically add to the client list — the Server Component
      // re-render is fast and guarantees consistency with the DB.
      router.refresh();

      // Navigate to the room after a short delay so the success state is visible.
      setTimeout(() => {
        router.push(`/rooms/${room.id}`);
      }, 1800);
    },
    [router],
  );

  return (
    <>
      <Button
        onClick={() => setIsDialogOpen(true)}
        leftIcon={<Plus className="h-4 w-4" aria-hidden="true" />}
        aria-label="Create a new watch room"
        className={isPremium ? "" : "opacity-90"}
      >
        New Room
      </Button>

      {/* Portal-rendered dialog with AnimatePresence for smooth exit */}
      <AnimatePresence>
        {isDialogOpen && (
          <CreateRoomDialog
            onClose={() => setIsDialogOpen(false)}
            onCreated={handleCreated}
          />
        )}
      </AnimatePresence>
    </>
  );
}
