<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\User;

/**
 * @extends AbstractRepository<User>
 */
final class UserRepository extends AbstractRepository
{
    /**
     * @return list<User>
     */
    public function findActiveUsers(): array
    {
        return array_values(array_filter($this->findAll(), static fn (User $user): bool => $user->isActive()));
    }
}
