"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { AlertTriangle } from "lucide-react";
import { useState } from "react";

export function VotingTab() {
  const [votingThreshold, setVotingThreshold] = useState([2]);
  const [voteDuration, setVoteDuration] = useState("7");

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-6 space-y-6">
        <div>
          <h3 className="text-lg font-semibold">Voting Threshold</h3>
          <p className="text-sm text-muted-foreground">
            The number of votes required for a proposal to pass.
          </p>
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>1</span>
            <span className="text-2xl font-bold text-foreground">{votingThreshold[0]}</span>
            <span>3</span>
            <span>4</span>
          </div>

          <Slider
            value={votingThreshold}
            onValueChange={setVotingThreshold}
            min={1}
            max={4}
            step={1}
            className="w-full"
          />

          <div className="flex items-start gap-2 rounded-lg bg-blue-500/10 p-4 border border-blue-500/20">
            <AlertTriangle className="h-5 w-5 text-blue-500 shrink-0 mt-0.5" />
            <p className="text-sm text-blue-500">
              A 2-of-4 threshold provides a good balance between security and operational flexibility.
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 space-y-4">
        <div>
          <h3 className="text-lg font-semibold">Vote Duration</h3>
          <p className="text-sm text-muted-foreground">
            The length of time (in days) a proposal will remain open for voting.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="vote-duration">Days</Label>
          <Input
            id="vote-duration"
            type="number"
            value={voteDuration}
            onChange={(e) => setVoteDuration(e.target.value)}
            min="1"
          />
        </div>
      </div>

      <div className="rounded-lg border bg-card">
        <Button className="w-full h-14 text-base font-semibold rounded-lg">
          Create Request
        </Button>
      </div>
    </div>
  );
}
