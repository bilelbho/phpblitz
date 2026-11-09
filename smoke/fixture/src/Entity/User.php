<?php

declare(strict_types=1);

namespace App\Entity;

final class User
{
    public function __construct(
        private readonly int $id,
        private readonly string $name,
        private bool $active = true,
    ) {
    }

    public function getId(): int
    {
        return $this->id;
    }

    public function getName(): string
    {
        return $this->name;
    }

    public function isActive(): bool
    {
        return $this->active;
    }
}
