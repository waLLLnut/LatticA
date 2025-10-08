use anchor_lang::prelude::*;

declare_id!("kRahi685jxKyTgcQadEPwyEKR8xtP9T21qmpwMfzSid");

#[program]
pub mod lattica_gatekeeper {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
